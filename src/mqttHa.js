import mqtt from "mqtt";
import { BridgeError } from "./errors.js";

const SENSOR_DEFS = [
  ["primary_used_percent", "Codex Primary Used", "%", "mdi:timer-sand"],
  ["primary_remaining_percent", "Codex Primary Remaining", "%", "mdi:timer-outline"],
  ["primary_reset_time", "Codex Primary Reset", null, "mdi:clock-outline"],
  ["secondary_used_percent", "Codex Secondary Used", "%", "mdi:calendar-week"],
  [
    "secondary_remaining_percent",
    "Codex Secondary Remaining",
    "%",
    "mdi:calendar-check",
  ],
  ["secondary_reset_time", "Codex Secondary Reset", null, "mdi:calendar-clock"],
  ["credits_balance", "Codex Credits", "credits", "mdi:cash"],
  ["plan", "Codex Plan", null, "mdi:account-badge"],
  ["rate_limit_reached_type", "Codex Limit Status", null, "mdi:alert-circle"],
];

export function createMqttClient(config) {
  return mqtt.connect(config.mqtt.url, {
    clientId: `codex-ha-${config.device.id}`,
    username: config.mqtt.username,
    password: config.mqtt.password,
    ca: config.mqtt.ca,
    rejectUnauthorized: true,
    keepalive: config.mqtt.keepalive,
    connectTimeout: config.mqtt.timeoutMs,
    reconnectPeriod: 0, // Bridge owns backoff; every attempt gets a fresh bounded client.
    queueQoSZero: false,
    clean: true,
    resubscribe: false,
    manualConnect: true,
    log: () => {},
    will: {
      topic: `${config.mqtt.baseTopic}/availability`, payload: "offline", qos: 1, retain: true,
    },
  });
}

function discoveryTopic(config, key) {
  return `${config.mqtt.discoveryPrefix}/sensor/${config.device.id}/${key}/config`;
}

function stateTopic(config) {
  return `${config.mqtt.baseTopic}/state`;
}

function availabilityTopic(config) {
  return `${config.mqtt.baseTopic}/availability`;
}

export async function publishDiscovery(client, config) {
  const device = {
    identifiers: [config.device.id],
    name: config.device.name,
    manufacturer: "OpenAI",
    model: "Codex Usage Bridge",
  };

  for (const [key, name, unit, icon] of SENSOR_DEFS) {
    const payload = {
      name,
      unique_id: `${config.device.id}_${key}`,
      state_topic: stateTopic(config),
      availability_topic: availabilityTopic(config),
      value_template: `{{ value_json.${key} if value_json.${key} is not none else ${unit ? "none" : "'unknown'"} }}`,
      expire_after: config.pollSeconds * 3,
      json_attributes_topic: stateTopic(config),
      device,
      icon,
    };

    if (unit) payload.unit_of_measurement = unit;

    await publish(client, discoveryTopic(config, key), payload, config.mqtt.timeoutMs);
  }
}

export async function publishAvailability(client, config, status) {
  await publish(client, availabilityTopic(config), status, config.mqtt.timeoutMs);
}

export async function publishState(client, config, state) {
  await publish(client, stateTopic(config), state, config.mqtt.timeoutMs);
}

export function publish(client, topic, payload, timeoutMs) {
  if (!client.connected || client.disconnecting) return Promise.reject(new BridgeError("MQTT_OFFLINE"));
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new BridgeError("MQTT_FAILED"));
      else resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BridgeError("MQTT_TIMEOUT"));
      // Drop late queued publishes; reconnect must fetch a fresh snapshot.
      client.end(true);
    }, timeoutMs);
    try { client.publish(topic, body, { qos: 1, retain: true }, finish); }
    catch { finish(true); }
  });
}
