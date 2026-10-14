import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { createLogger } from "./logger.js";

let bridge;
try {
  bridge = new Bridge(loadConfig());
  bridge.start();
} catch (error) {
  createLogger().error(error);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await bridge?.stop();
    process.exit(0);
  });
}
