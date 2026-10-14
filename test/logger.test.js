import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/logger.js";
import { BridgeError } from "../src/errors.js";

test("errors, event names and causes never expose untrusted text", () => {
  const output = [];
  const logger = createLogger({ output: { log: line => output.push(line), error: line => output.push(line) } });
  logger.error(new Error("DUMMY_SECRET", { cause: "DUMMY_PASSWORD" }));
  logger.error({ code: "DUMMY_SECRET", message: "DUMMY_SECRET" });
  logger.error(new BridgeError("DUMMY_SECRET"));
  logger.info("DUMMY_SECRET");
  assert.doesNotMatch(output.join("\n"), /DUMMY_/);
});

test("log rotation is bounded and files are private", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-logs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "logs", "bridge.log");
  const logger = createLogger({ file, maxBytes: 100, backups: 2 });
  for (let i = 0; i < 20; i++) logger.error(new Error("DUMMY_SECRET"));
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["bridge.log", "bridge.log.1", "bridge.log.2"]);
  for (const name of fs.readdirSync(path.dirname(file))) {
    const log = path.join(path.dirname(file), name);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /DUMMY_SECRET/);
    if (process.platform !== "win32") assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  }
});

test("a dangling log symlink is refused without creating its target", t => {
  if (process.platform === "win32") return; // Windows symlink creation requires host-specific privileges.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-log-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "bridge.log");
  const target = path.join(root, "unrelated");
  fs.symlinkSync(target, file);
  const output = [];
  createLogger({ file, output: { error: line => output.push(line) } }).info("starting");
  assert.equal(fs.existsSync(target), false);
  assert.match(output[0], /LOG_FAILED/);
});

test("rotation tightens permissions on legacy logs before archiving them", t => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-log-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "bridge.log");
  fs.writeFileSync(file, "old log".repeat(100), { mode: 0o644 });
  fs.chmodSync(file, 0o644); // Exercise legacy permissions even under umask 0077.
  createLogger({ file, maxBytes: 100 }).info("starting");
  assert.equal(fs.statSync(`${file}.1`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});
