import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, loadConfig } from "../src/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const options = { homeDirectory: root, cwd: root };

test("secure defaults use a separate home and retain established identifiers", () => {
  const config = parseConfig({}, options);
  assert.equal(config.mqtt.url, "mqtts://homeassistant.local:8883");
  assert.equal(config.codex.home, path.join(fs.realpathSync(root), ".codex-ha-bridge"));
  assert.equal(config.device.id, "codex_usage");
});

test("unsafe transport and configuration are rejected without echoing input", () => {
  for (const env of [
    { MQTT_URL: "mqtt://192.168.1.50:1883" },
    { MQTT_URL: "mqtt://localhost:1883" },
    { MQTT_URL: "mqtt://192.168.1.50:1883", MQTT_ALLOW_LOOPBACK_PLAINTEXT: "true" },
    { MQTT_URL: "mqtts://DUMMY_SECRET:password@example.com" },
    { MQTT_URL: "mqtts://example.com/?password=DUMMY_SECRET" },
    { MQTT_URL: "https://example.com" },
    { MQTT_BASE_TOPIC: "codex/#" }, { HA_DISCOVERY_PREFIX: "homeassistant/+" },
    { DEVICE_ID: "../DUMMY_SECRET" }, { POLL_SECONDS: "60junk" }, { POLL_SECONDS: "0" },
    { MQTT_TIMEOUT_SECONDS: "99999999999" }, { CODEX_ACCESS_TOKEN: "DUMMY_SECRET" },
    { CODEX_REFRESH_TOKEN_URL: "http://attacker.invalid" },
    { CODEX_EXECUTABLE: "relative.cmd" }, { BRIDGE_LOG_TO_FILE: "yes" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { DEBUG: "mqttjs*" },
  ]) {
    assert.throws(() => parseConfig(env, options), error => !error.message.includes("DUMMY_SECRET"));
  }
});

test("only explicitly opted-in loopback plaintext is accepted", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.ok(parseConfig({ MQTT_URL: `mqtt://${host}:1883`, MQTT_ALLOW_LOOPBACK_PLAINTEXT: "true" }, options));
  }
});

test("desktop home, its ancestors, descendants and symlink aliases are refused", () => {
  const desktop = path.join(root, ".codex");
  fs.mkdirSync(desktop);
  const alias = path.join(root, "alias");
  fs.symlinkSync(desktop, alias, process.platform === "win32" ? "junction" : "dir");
  for (const home of [root, desktop, path.join(desktop, "bridge"), alias, path.join(alias, "bridge")]) {
    assert.throws(() => parseConfig({ CODEX_BRIDGE_HOME: home }, options), { code: "CODEX_HOME_UNSAFE" });
  }
});

test("dotenv never injects arbitrary variables into this process", () => {
  const cwd = process.cwd();
  fs.writeFileSync(path.join(root, ".env"), "BRIDGE_TEST_INJECTED=DUMMY_SECRET\nNODE_OPTIONS=--require malicious.js\n");
  try {
    process.chdir(root);
    loadConfig();
    assert.equal(process.env.BRIDGE_TEST_INJECTED, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
  } finally { process.chdir(cwd); }
});

test("loopback tunnel does not depend on localhost DNS and all Boolean settings are validated", () => {
  const config = parseConfig({ MQTT_URL: "mqtt://localhost:1883", MQTT_ALLOW_LOOPBACK_PLAINTEXT: "true" }, options);
  assert.equal(new URL(config.mqtt.url).hostname, "127.0.0.1");
  assert.throws(() => parseConfig({ MQTT_ALLOW_LOOPBACK_PLAINTEXT: "yes" }, options), { code: "CONFIG_INVALID" });
  assert.throws(() => parseConfig({ MQTT_URL: "mqtts:" }, options), { code: "CONFIG_INVALID" });
});
