import fs from "node:fs";
import path from "node:path";
import { BridgeError, safeError } from "./errors.js";

const EVENTS = Object.freeze({
  starting: "Bridge starting.", connected: "MQTT connected.",
  published: "Fresh Codex usage published.", stopped: "Bridge stopped.",
  retrying: "MQTT disconnected; retry scheduled.",
});

export function createLogger({ file, maxBytes = 5 * 1024 * 1024, backups = 3, output = console } = {}) {
  function checked(filePath, directory = false) {
    let stat;
    try { stat = fs.lstatSync(filePath); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new BridgeError("LOG_FAILED");
    if (process.platform !== "win32") fs.chmodSync(filePath, directory ? 0o700 : 0o600);
  }
  function write(text, isError = false) {
    const line = `${new Date().toISOString()} ${text}`;
    if (!file) {
      (isError ? output.error : output.log).call(output, line);
      return;
    }
    try {
      checked(path.dirname(file), true);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      checked(file);
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) + 1 > maxBytes) {
        for (let n = backups; n >= 1; n--) {
          const previous = n === 1 ? file : `${file}.${n - 1}`;
          const next = `${file}.${n}`;
          checked(previous); checked(next);
          if (fs.existsSync(next)) fs.unlinkSync(next);
          if (fs.existsSync(previous)) fs.renameSync(previous, next);
        }
      }
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    } catch {
      output.error(safeError(new BridgeError("LOG_FAILED")));
    }
  }
  return {
    info(event) { write(EVENTS[event] ?? "Bridge status changed."); },
    error(error) { write(safeError(error), true); },
  };
}
