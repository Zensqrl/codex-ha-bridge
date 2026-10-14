import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexClient, childEnvironment } from "../src/codexClient.js";
import { safeError } from "../src/errors.js";

function fixture(t, handler) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codex-"));
  const proc = new EventEmitter();
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.kill = signal => { proc.killedWith = signal; queueMicrotask(() => proc.emit("exit", 0)); return true; };
  const requests = [];
  proc.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString()); requests.push(message);
    if (message.id !== undefined) handler(message, response => proc.stdout.write(`${JSON.stringify({ id: message.id, ...response })}\n`));
    callback();
  } });
  let launch;
  const client = new CodexClient({ home, executable: "codex", timeoutMs: 30 }, {
    spawnProcess: (...args) => { launch = args; return proc; },
  });
  t.after(() => { client.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { client, proc, requests, getLaunch: () => launch, home };
}
const respond = (message, send) => send({ result: message.method === "account/read" ? { account: { type: "chatgpt", planType: "plus", email: "PRIVATE_EMAIL" } } : message.method === "account/rateLimits/read" ? { rateLimits: {} } : {} });

test("stdio adapter reads only approved account methods without modifying auth", async t => {
  const f = fixture(t, respond);
  const auth = path.join(f.home, "auth.json");
  fs.writeFileSync(auth, "DUMMY_AUTH_FILE_DO_NOT_PARSE", { mode: 0o600 });
  await f.client.readUsage();
  assert.equal(fs.readFileSync(auth, "utf8"), "DUMMY_AUTH_FILE_DO_NOT_PARSE");
  assert.deepEqual(f.requests.map(r => r.method), ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  const [, args, options] = f.getLaunch();
  assert.equal(options.shell, false);
  assert.equal(options.cwd, f.home);
  assert.equal(options.env.CODEX_HOME, f.home);
  assert.ok(args.includes("stdio://"));
  await assert.rejects(f.client.request("turn/start", {}), { code: "CODEX_PROTOCOL" });
});

test("child receives no inherited bridge secrets, tokens or execution overrides", () => {
  const env = childEnvironment("/dedicated", { PATH: "/safe", MQTT_PASSWORD: "DUMMY_SECRET", CODEX_ACCESS_TOKEN: "DUMMY_SECRET", OPENAI_API_KEY: "DUMMY_SECRET", NODE_OPTIONS: "malicious", CODEX_HOME: "/desktop", DEBUG: "*" });
  assert.deepEqual(env, { PATH: "/safe", CODEX_HOME: "/dedicated" });
});

test("request timeout rejects pending work, kills child and clears its request map", async t => {
  const f = fixture(t, (message, send) => { if (message.method === "initialize") send({ result: {} }); });
  await assert.rejects(f.client.readUsage(), { code: "CODEX_TIMEOUT" });
  assert.equal(f.proc.killedWith, "SIGTERM");
  assert.equal(f.client.pending.size, 0);
  assert.equal(f.client.proc, null);
});

test("fragmented UTF-8 and multiple responses are framed correctly; raw errors are suppressed", async t => {
  const f = fixture(t, (message, send) => {
    if (message.method === "initialize") {
      const bytes = Buffer.from(JSON.stringify({ id: message.id, result: { note: "é" } }) + "\n");
      const cut = bytes.indexOf(0xc3) + 1;
      f.proc.stdout.write(bytes.subarray(0, cut)); f.proc.stdout.write(bytes.subarray(cut));
    } else send({ error: { message: "DUMMY_ACCESS_TOKEN PRIVATE_EMAIL" } });
  });
  await assert.rejects(f.client.readUsage(), error => {
    assert.doesNotMatch(safeError(error), /DUMMY_ACCESS_TOKEN|PRIVATE_EMAIL/);
    return error.code === "CODEX_REQUEST_FAILED";
  });
  f.proc.stderr.write("DUMMY_ACCESS_TOKEN");
});

test("malformed or oversized protocol messages stop the child", async t => {
  for (const bytes of ["not-json\n", "x".repeat(1024 * 1024 + 1)]) {
    const f = fixture(t, () => queueMicrotask(() => f.proc.stdout.write(bytes)));
    await assert.rejects(f.client.readUsage(), { code: "CODEX_PROTOCOL" });
    assert.equal(f.proc.killedWith, "SIGTERM");
  }
});

test("missing login and unsafe auth-file permissions fail safely", async t => {
  const f = fixture(t, (message, send) => send({ result: message.method === "initialize" ? {} : { account: null } }));
  await assert.rejects(f.client.readUsage(), { code: "CODEX_AUTH_REQUIRED" });
  f.client.close();
  const g = fixture(t, respond);
  fs.writeFileSync(path.join(g.home, "auth.json"), "dummy", { mode: 0o644 });
  if (process.platform !== "win32") await assert.rejects(g.client.readUsage(), { code: "CODEX_HOME_UNSAFE" });
});

test("an actual hung child is forcibly reaped after ignoring SIGTERM", async t => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-child-"));
  let proc;
  let exited;
  const client = new CodexClient({ home, executable: "codex", timeoutMs: 200 }, {
    spawnProcess: (_executable, _args, options) => {
      proc = spawn(process.execPath, [new URL("./helpers/fakeCodex.mjs", import.meta.url).pathname], options);
      exited = once(proc, "exit");
      return proc;
    },
  });
  t.after(() => { client.close(); proc?.kill("SIGKILL"); fs.rmSync(home, { recursive: true, force: true }); });
  await assert.rejects(client.readUsage(), { code: "CODEX_TIMEOUT" });
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.deepEqual(fs.readdirSync(home), []);
});

test("auth symlinks and hard links are refused before starting Codex", async t => {
  if (process.platform === "win32") return;
  for (const kind of ["symlink", "hardlink"]) {
    const f = fixture(t, respond);
    const auth = path.join(f.home, "auth.json");
    const target = path.join(f.home, "other-auth.json");
    if (kind === "symlink") fs.symlinkSync(target, auth); // Includes dangling links.
    else { fs.writeFileSync(target, "DUMMY_SECRET", { mode: 0o600 }); fs.linkSync(target, auth); }
    await assert.rejects(f.client.readUsage(), { code: "CODEX_HOME_UNSAFE" });
    assert.equal(f.getLaunch(), undefined);
  }
});
