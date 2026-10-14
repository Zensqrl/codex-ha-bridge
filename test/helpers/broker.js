import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import mqttPacket from "mqtt-packet";

export async function broker(t, { acknowledge = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tls-"));
  const key = path.join(root, "key.pem");
  const cert = path.join(root, "cert.pem");
  const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("Test requires openssl with -addext support");
  const sockets = new Set();
  const state = { messages: [], connections: [], wills: [], pings: 0, acknowledge };
  const server = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, socket => {
    sockets.add(socket);
    const parser = mqttPacket.parser();
    let will;
    let graceful = false;
    socket.on("error", () => {});
    socket.on("data", bytes => parser.parse(bytes));
    parser.on("error", () => socket.destroy());
    parser.on("packet", packet => {
      if (packet.cmd === "connect") {
        state.connections.push(packet);
        if (packet.username !== "bridge-test" || packet.password.toString() !== "DUMMY_MQTT_PASSWORD") {
          socket.end(mqttPacket.generate({ cmd: "connack", returnCode: 4 }));
          return;
        }
        will = packet.will;
        const ack = mqttPacket.generate({ cmd: "connack", returnCode: 0 });
        // Reproduce the original bug: CONNACK split across TCP reads.
        socket.write(ack.subarray(0, 2));
        setTimeout(() => { if (!socket.destroyed) socket.write(ack.subarray(2)); }, 5);
      } else if (packet.cmd === "publish") {
        state.messages.push({ topic: packet.topic, body: packet.payload.toString(), retain: packet.retain });
        const allowed = packet.topic.startsWith("codex/usage/") || packet.topic.startsWith("homeassistant/sensor/codex_usage/");
        if (!allowed) return socket.destroy();
        if (state.acknowledge && packet.qos === 1) socket.write(mqttPacket.generate({ cmd: "puback", messageId: packet.messageId }));
      } else if (packet.cmd === "pingreq") {
        state.pings++;
        socket.write(mqttPacket.generate({ cmd: "pingresp" }));
      } else if (packet.cmd === "disconnect") {
        graceful = true; socket.end();
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (!graceful && will) state.wills.push({ topic: will.topic, body: will.payload.toString(), retain: will.retain });
    });
  });
  server.on("tlsClientError", () => {});
  server.on("error", () => {});
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  state.config = {
    mqtt: { url: `mqtts://localhost:${server.address().port}`, username: "bridge-test", password: "DUMMY_MQTT_PASSWORD", ca: fs.readFileSync(cert), baseTopic: "codex/usage", discoveryPrefix: "homeassistant", keepalive: 1, timeoutMs: 500 },
    device: { id: "codex_usage", name: "Codex Usage" }, pollSeconds: 60, shutdownMs: 500,
  };
  return state;
}

export async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
