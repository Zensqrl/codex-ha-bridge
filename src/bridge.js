import { CodexClient } from "./codexClient.js";
import { flattenForMqtt, normalizeSnapshot } from "./codexUsage.js";
import { createMqttClient, publishAvailability, publishDiscovery, publishState } from "./mqttHa.js";
import { createLogger } from "./logger.js";
import { BridgeError } from "./errors.js";

export class Bridge {
  constructor(config, { source = new CodexClient(config.codex), mqttFactory = createMqttClient, logger = createLogger({ file: config.logFile }), random = Math.random } = {}) {
    this.config = config;
    this.source = source;
    this.mqttFactory = mqttFactory;
    this.logger = logger;
    this.random = random;
    this.stopping = false;
    this.running = false;
    this.failures = 0;
  }

  start() {
    this.logger.info("starting");
    this.connect();
  }

  connect() {
    if (this.stopping) return;
    let client;
    try { client = this.mqttFactory(this.config); }
    catch {
      this.logger.error(new BridgeError("MQTT_FAILED"));
      this.retry();
      return;
    }
    this.client = client;
    client.on("error", () => this.logger.error(new BridgeError("MQTT_FAILED")));
    client.on("connect", () => {
      if (this.stopping || this.client !== client) return client.end(true);
      this.logger.info("connected");
      this.schedulePoll(0);
    });
    client.on("close", () => {
      if (this.client !== client) return;
      this.client = null;
      clearTimeout(this.pollTimer);
      client.end(true); // Retire old stores/timers before making another client.
      if (!this.stopping) this.retry();
    });
    client.connect();
  }

  retry() {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5));
    this.logger.info("retrying");
    this.retryTimer = setTimeout(() => this.connect(), Math.round(delay * (0.8 + this.random() * 0.4)));
  }

  schedulePoll(delay) {
    clearTimeout(this.pollTimer);
    if (!this.stopping && this.client?.connected) this.pollTimer = setTimeout(() => this.poll(), delay);
  }

  async poll() {
    if (this.running || this.stopping || !this.client?.connected) return;
    this.running = true;
    const client = this.client;
    try {
      // Clear previously retained online status before doing work on this connection.
      if (!client.bridgeReady) {
        await publishAvailability(client, this.config, "offline");
        await publishDiscovery(client, this.config);
        client.bridgeReady = true;
      }
      const state = flattenForMqtt(normalizeSnapshot(await this.source.readUsage()));
      if (this.stopping || this.client !== client || !client.connected) return;
      await publishState(client, this.config, state);
      if (this.stopping || this.client !== client || !client.connected) return;
      await publishAvailability(client, this.config, "online");
      this.failures = 0;
      this.logger.info("published");
    } catch (error) {
      if (!this.stopping) {
        if (this.client === client && client.connected) await publishAvailability(client, this.config, "offline").catch(() => {});
        this.logger.error(error);
      }
    } finally {
      this.running = false;
      this.schedulePoll(this.client !== client ? 0 : this.config.pollSeconds * 1000);
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retryTimer);
    const sourceClosed = Promise.resolve(this.source.close()).catch(error => this.logger.error(error));
    const client = this.client;
    this.stopPromise = new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client?.end(true);
        this.logger.info("stopped");
        // Keep the parent alive long enough to reap its owned native child.
        sourceClosed.then(resolve);
      };
      const timer = setTimeout(finish, this.config.shutdownMs);
      if (!client) return finish();
      // Shutdown may interrupt a poll. Disconnect once offline is acknowledged.
      publishAvailability(client, this.config, "offline").catch(() => {}).then(() => {
        if (done) return;
        client.end(false, {}, finish);
      });
    });
    return this.stopPromise;
  }
}
