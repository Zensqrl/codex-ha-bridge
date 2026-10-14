import test from "node:test";
import assert from "node:assert/strict";
import { broker, until } from "./helpers/broker.js";
import { createMqttClient, publish } from "../src/mqttHa.js";
import { Bridge } from "../src/bridge.js";

async function connect(t, config) {
  const client = createMqttClient(config);
  t.after(() => client.end(true));
  await new Promise((resolve, reject) => {
    client.once("connect", resolve); client.once("error", reject);
    client.connect();
  });
  return client;
}

test("verified TLS handles split CONNACK, acknowledged state, keepalive and abrupt last will", async t => {
  const fixture = await broker(t);
  const client = await connect(t, fixture.config);
  assert.equal(fixture.connections[0].will.topic, "codex/usage/availability");
  assert.equal(fixture.connections[0].will.retain, true);
  await publish(client, "codex/usage/state", { primary_used_percent: 25 }, 500);
  assert.equal(fixture.messages[0].retain, true);
  await until(() => fixture.pings > 0);
  client.end(true);
  await until(() => fixture.wills.length > 0);
  assert.equal(fixture.wills[0].body, "offline");
});

test("untrusted and hostname-mismatched certificates fail before MQTT credentials are sent", async t => {
  const fixture = await broker(t);
  await assert.rejects(connect(t, { ...fixture.config, mqtt: { ...fixture.config.mqtt, ca: undefined } }));
  await assert.rejects(connect(t, { ...fixture.config, mqtt: { ...fixture.config.mqtt, url: fixture.config.mqtt.url.replace("localhost", "127.0.0.1") } }));
  assert.equal(fixture.connections.length, 0);
});

test("lost PUBACK retires connection and publishes offline will", async t => {
  const fixture = await broker(t, { acknowledge: false });
  const client = await connect(t, fixture.config);
  await assert.rejects(publish(client, "codex/usage/state", "dummy", 30), { code: "MQTT_TIMEOUT" });
  await until(() => fixture.wills.length > 0);
  assert.equal(client.connected, false);
});

test("bridge reconnect publishes fresh state before online and graceful shutdown stays offline", async t => {
  const fixture = await broker(t);
  const logs = [];
  let polls = 0;
  const source = { readUsage: async () => ({ rateLimits: { limitId: "codex", primary: { usedPercent: ++polls }, rateLimitReachedType: null } }), close() {} };
  const bridge = new Bridge(fixture.config, { source, random: () => 0, logger: { info: event => logs.push(event), error: error => logs.push(error.code) } });
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => fixture.messages.some(m => m.body === "online"));
  assert.equal(fixture.messages[0].body, "offline");
  const firstState = fixture.messages.findIndex(m => m.topic.endsWith("/state"));
  assert.ok(firstState < fixture.messages.findIndex(m => m.body === "online"));
  assert.equal(fixture.messages.filter(m => m.topic.endsWith("/config")).length, 9);
  bridge.client.end(true);
  await until(() => polls >= 2 && fixture.messages.filter(m => m.body === "online").length >= 2);
  assert.equal(JSON.parse(fixture.messages.filter(m => m.topic.endsWith("/state")).at(-1).body).primary_used_percent, 2);
  await bridge.stop();
  assert.equal(fixture.messages.at(-1).body, "offline");
  assert.doesNotMatch(logs.join(" "), /DUMMY_MQTT_PASSWORD/);
});

test("restricted broker rejects writes outside the bridge's topic scope", async t => {
  const fixture = await broker(t);
  const client = await connect(t, fixture.config);
  await assert.rejects(publish(client, "unrelated/device/command", "dummy", 100));
  await until(() => fixture.wills.length > 0);
});
