import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BridgeError } from "./errors.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const ALLOWED_METHODS = new Set(["initialize", "account/read", "account/rateLimits/read"]);

export function childEnvironment(home, env = process.env) {
  const result = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "SSL_CERT_FILE", "CODEX_CA_CERTIFICATE"]) {
    if (env[key]) result[key] = env[key];
  }
  result.CODEX_HOME = home;
  return result;
}

export class CodexClient {
  constructor(config, { spawnProcess = spawn } = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.reaping = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  async start() {
    if (this.closed) throw new BridgeError("STOPPED");
    if (this.starting) return this.starting;
    if (this.proc) return;
    this.starting = this.initialize();
    try { await this.starting; }
    finally { this.starting = null; }
  }

  async initialize() {
    // Login is explicitly performed by the user; don't create or copy credentials here.
    try {
      const stat = fs.lstatSync(this.config.home);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error();
      const authPath = path.join(this.config.home, "auth.json");
      let authStat;
      try { authStat = fs.lstatSync(authPath); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (authStat) {
        if (!authStat.isFile() || authStat.isSymbolicLink() || authStat.nlink !== 1 ||
            (process.platform !== "win32" && (authStat.mode & 0o077))) throw new Error();
      }
    } catch { throw new BridgeError("CODEX_HOME_UNSAFE"); }
    let proc;
    try {
      proc = this.spawnProcess(this.config.executable, [
        "app-server", "--listen", "stdio://",
        "-c", 'cli_auth_credentials_store="file"',
        "-c", 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        "-c", 'model_provider="openai"',
        "-c", "analytics.enabled=false",
      ], { cwd: this.config.home, env: childEnvironment(this.config.home), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch { throw new BridgeError("CODEX_UNAVAILABLE"); }
    this.proc = proc;
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    proc.stdout.on("data", chunk => {
      if (this.proc !== proc) return;
      buffer += decoder.write(chunk);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return this.fail(proc, "CODEX_PROTOCOL");
        try { this.receive(proc, JSON.parse(line)); }
        catch { return this.fail(proc, "CODEX_PROTOCOL"); }
        if (this.proc !== proc) return;
      }
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) this.fail(proc, "CODEX_PROTOCOL");
    });
    // Drain stderr without logging it: it is an untrusted source of credentials/PII.
    proc.stderr.resume();
    proc.stdin.on("error", () => this.fail(proc, "CODEX_UNAVAILABLE"));
    proc.on("error", () => this.fail(proc, "CODEX_UNAVAILABLE"));
    proc.on("exit", () => {
      proc.bridgeExited = true;
      this.fail(proc, "CODEX_UNAVAILABLE");
    });
    await this.request("initialize", { clientInfo: { name: "codex_ha_bridge", title: "Codex HA Bridge", version: "0.2.0" } });
    this.send(proc, { method: "initialized" });
  }

  receive(proc, message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new BridgeError("CODEX_PROTOCOL");
    if (typeof message.method === "string") {
      // This adapter does not provide tools, login actions or external token refresh.
      if (message.id !== undefined) this.send(proc, { id: message.id, error: { code: -32601, message: "Method not supported" } });
      return;
    }
    if (!Number.isSafeInteger(message.id)) throw new BridgeError("CODEX_PROTOCOL");
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, "error")) pending.reject(new BridgeError(message.error?.code === -32601 ? "CODEX_PROTOCOL" : "CODEX_REQUEST_FAILED"));
    else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(new BridgeError("CODEX_PROTOCOL"));
  }

  send(proc, message) {
    if (this.proc !== proc || proc.stdin.destroyed) throw new BridgeError("CODEX_UNAVAILABLE");
    proc.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error) this.fail(proc, "CODEX_UNAVAILABLE");
    });
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new BridgeError("STOPPED"));
    if (!ALLOWED_METHODS.has(method) || this.pending.size >= 2) return Promise.reject(new BridgeError("CODEX_PROTOCOL"));
    const proc = this.proc;
    if (!proc) return Promise.reject(new BridgeError("CODEX_UNAVAILABLE"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(proc, "CODEX_TIMEOUT"), this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(proc, { id, method, ...(params === undefined ? {} : { params }) }); }
      catch { this.fail(proc, "CODEX_UNAVAILABLE"); }
    });
  }

  fail(proc, code) {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError(code));
    }
    this.pending.clear();
    this.terminate(proc);
  }

  terminate(proc) {
    // All owned children have a bounded lifetime, including a hung timed-out child.
    if (proc.bridgeExited) return Promise.resolve();
    if (this.reaping.has(proc)) return this.reaping.get(proc);
    const reaped = new Promise(resolve => {
      const force = setTimeout(() => proc.kill("SIGKILL"), 500);
      const deadline = setTimeout(resolve, 1000);
      proc.once("exit", () => { clearTimeout(force); clearTimeout(deadline); resolve(); });
      proc.kill("SIGTERM");
    });
    this.reaping.set(proc, reaped);
    reaped.then(() => this.reaping.delete(proc));
    return reaped;
  }

  async readUsage() {
    await this.start();
    const account = await this.request("account/read", { refreshToken: false });
    if (!account?.account || account.account.type !== "chatgpt") throw new BridgeError("CODEX_AUTH_REQUIRED");
    const limits = await this.request("account/rateLimits/read");
    return { ...limits, accountPlan: account.account.planType };
  }

  close() {
    this.closed = true;
    if (this.proc) this.fail(this.proc, "STOPPED");
    return Promise.all([...this.reaping.values()]);
  }
}
