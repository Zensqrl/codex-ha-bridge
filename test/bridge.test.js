import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Bridge } from "../src/bridge.js";
import { publish } from "../src/mqttHa.js";
import { BridgeError } from "../src/errors.js";

const config = {
  mqtt: { url: "mqtts://unused", timeoutMs: 25, baseTopic: "codex/usage", discoveryPrefix: "homeassistant" },
  device: { id: "codex_usage", name: "Codex Usage" }, pollSeconds: 0.015, shutdownMs: 30,
};
const snapshot = { rateLimits: { limitId: "codex", primary: { usedPercent: 10 }, rateLimitReachedType: null } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client extends EventEmitter {
  connected = false;
  messages = [];
  connect() { this.connected = true; queueMicrotask(() => this.emit("connect")); }
  publish(topic, body, options, callback) { this.messages.push({ topic, body, options }); callback(); }
  end(_force, options, callback) {
    if (this.connected) { this.connected = false; queueMicrotask(() => this.emit("close")); }
    callback?.();
  }
}

function bridge(t, source) {
  const clients = [];
  const logs = [];
  const b = new Bridge(config, { source, mqttFactory: () => { const c = new Client(); clients.push(c); return c; },
    logger: { info: event => logs.push(event), error: error => logs.push(error.code) }, random: () => 0 });
  t.after(() => b.stop());
  b.start();
  return { b, clients, logs };
}

test("fresh state precedes online, discovery identities preserved, shutdown finishes offline", async t => {
  const { b, clients } = bridge(t, { readUsage: async () => snapshot, close() {} });
  await delay(10);
  const messages = clients[0].messages;
  assert.equal(messages[0].body, "offline");
  const stateAt = messages.findIndex(m => m.topic.endsWith("/state"));
  const onlineAt = messages.findIndex(m => m.body === "online");
  assert.ok(stateAt > 0 && onlineAt > stateAt);
  const discovery = messages.filter(m => m.topic.endsWith("/config"));
  assert.equal(discovery.length, 9);
  assert.equal(JSON.parse(discovery[0].body).unique_id, "codex_usage_primary_used_percent");
  assert.match(JSON.parse(discovery[0].body).value_template, /unknown/);
  await b.stop();
  assert.equal(messages.at(-1).body, "offline");
});

test("overlapping polls are skipped and failures never publish online", async t => {
  let calls = 0;
  let release;
  const { b, clients } = bridge(t, { readUsage: () => { calls++; return new Promise((_, reject) => { release = () => reject(new BridgeError("CODEX_TIMEOUT")); }); }, close() { release?.(); } });
  await delay(5);
  await Promise.all([b.poll(), b.poll()]);
  assert.equal(calls, 1);
  assert.ok(!clients[0].messages.some(m => m.body === "online"));
  release();
  await delay(5);
  await b.stop();
});

test("shutdown interrupts stalled work and prevents later online publishes", async t => {
  let release;
  const { b, clients } = bridge(t, { readUsage: () => new Promise(resolve => { release = resolve; }), close() { release?.(snapshot); } });
  await delay(5);
  await b.stop();
  await delay(5);
  assert.ok(!clients[0].messages.some(m => m.body === "online"));
  assert.equal(clients[0].messages.at(-1).body, "offline");
});

test("disconnected publishes fail immediately; lost PUBACK closes the old queue", async () => {
  const client = new Client();
  await assert.rejects(publish(client, "topic", "dummy", 10), { code: "MQTT_OFFLINE" });
  assert.equal(client.messages.length, 0);
  client.connected = true;
  client.publish = () => {};
  await assert.rejects(publish(client, "topic", "dummy", 10), { code: "MQTT_TIMEOUT" });
  assert.equal(client.connected, false);
});

test("shutdown has a deadline even if MQTT close never calls back", async t => {
  const { b, clients } = bridge(t, { readUsage: async () => snapshot, close() {} });
  await delay(5);
  clients[0].end = () => {};
  const started = Date.now();
  await b.stop();
  assert.ok(Date.now() - started < 500);
});

test("shutdown waits for owned child cleanup before resolving", async t => {
  let closed = false;
  const { b } = bridge(t, { readUsage: async () => snapshot, close: async () => { await delay(20); closed = true; } });
  await delay(5);
  await b.stop();
  assert.equal(closed, true);
});
