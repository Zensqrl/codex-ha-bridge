import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors.js";

const LEGACY = ["CODEX_ACCESS_TOKEN", "CHATGPT_ACCOUNT_ID", "CODEX_BACKEND_URL", "CODEX_REFRESH_TOKEN_URL"];

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) throw new BridgeError("CONFIG_INVALID");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function integer(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new BridgeError("CONFIG_INVALID");
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new BridgeError("CONFIG_INVALID");
  return number;
}

function boolean(env, key) {
  if (!env[key] || env[key] === "false") return false;
  if (env[key] === "true") return true;
  throw new BridgeError("CONFIG_INVALID");
}

function topic(value) {
  if (Buffer.byteLength(value) > 256 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) throw new BridgeError("CONFIG_INVALID");
  return value;
}

function canonical(filePath) {
  // Resolve existing ancestors too, so a symlink cannot hide a nested desktop home.
  let existing = filePath;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new BridgeError("CODEX_HOME_UNSAFE");
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function parseConfig(env, { homeDirectory = os.homedir(), cwd = process.cwd() } = {}) {
  if (LEGACY.some(key => env[key])) throw new BridgeError("LEGACY_AUTH_CONFIG");
  // Debug output and disabled TLS verification can bypass our safe logging/transport policy.
  if (env.DEBUG || env.NODE_DEBUG || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new BridgeError("CONFIG_INVALID");
  let url;
  try { url = new URL(env.MQTT_URL || "mqtts://homeassistant.local:8883"); }
  catch { throw new BridgeError("CONFIG_INVALID"); }
  const allowLoopback = boolean(env, "MQTT_ALLOW_LOOPBACK_PLAINTEXT");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url.hostname || url.port === "0") throw new BridgeError("CONFIG_INVALID");
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) throw new BridgeError("CONFIG_INVALID");
  if (url.protocol !== "mqtts:" && !(url.protocol === "mqtt:" && loopback && allowLoopback)) throw new BridgeError("CONFIG_INVALID");
  // An encrypted tunnel must terminate locally even if localhost DNS is overridden.
  if (url.protocol === "mqtt:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  const id = env.DEVICE_ID || "codex_usage";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BridgeError("CONFIG_INVALID");
  const name = env.DEVICE_NAME || "Codex Usage";
  if (name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new BridgeError("CONFIG_INVALID");
  const configuredHome = env.CODEX_BRIDGE_HOME || path.join(homeDirectory, ".codex-ha-bridge");
  if (!path.isAbsolute(configuredHome)) throw new BridgeError("CODEX_HOME_UNSAFE");
  const home = canonical(configuredHome);
  for (const desktop of [path.join(homeDirectory, ".codex"), env.CODEX_HOME].filter(Boolean)) {
    const desktopHome = canonical(path.resolve(desktop));
    if (contains(desktopHome, home) || contains(home, desktopHome)) throw new BridgeError("CODEX_HOME_UNSAFE");
  }
  const executable = env.CODEX_EXECUTABLE || "codex";
  if (executable !== "codex" && (!path.isAbsolute(executable) || /\.(cmd|bat|ps1)$/i.test(executable))) throw new BridgeError("CONFIG_INVALID");
  let ca;
  if (env.MQTT_CA_FILE) {
    try { ca = fs.readFileSync(path.resolve(cwd, env.MQTT_CA_FILE)); }
    catch { throw new BridgeError("CONFIG_INVALID"); }
  }
  return {
    mqtt: {
      url: url.href, username: env.MQTT_USERNAME || undefined, password: env.MQTT_PASSWORD || undefined,
      ca, baseTopic: topic(env.MQTT_BASE_TOPIC || "codex/usage"),
      discoveryPrefix: topic(env.HA_DISCOVERY_PREFIX || "homeassistant"),
      keepalive: integer(env, "MQTT_KEEPALIVE_SECONDS", 30, 5, 120),
      timeoutMs: integer(env, "MQTT_TIMEOUT_SECONDS", 10, 1, 60) * 1000,
    },
    codex: { home, executable, timeoutMs: integer(env, "CODEX_TIMEOUT_SECONDS", 20, 1, 120) * 1000 },
    device: { id, name },
    pollSeconds: integer(env, "POLL_SECONDS", 60, 10, 3600),
    shutdownMs: integer(env, "SHUTDOWN_SECONDS", 5, 1, 30) * 1000,
    logFile: boolean(env, "BRIDGE_LOG_TO_FILE") ? path.join(cwd, "logs", "bridge.log") : undefined,
  };
}

export function loadConfig() {
  // .env supplies bridge settings only; it never mutates the process/child environment.
  return parseConfig({ ...readDotEnv(path.resolve(".env")), ...process.env });
}
