const MESSAGES = Object.freeze({
  CONFIG_INVALID: "Invalid bridge configuration; check README configuration requirements.",
  LEGACY_AUTH_CONFIG: "Remove legacy token/backend settings; use a dedicated Codex bridge login.",
  CODEX_HOME_UNSAFE: "Codex bridge home must be a dedicated directory outside the desktop Codex home.",
  CODEX_UNAVAILABLE: "Codex app-server unavailable; check the native CLI executable and dedicated login.",
  CODEX_PROTOCOL: "Unsupported or malformed Codex app-server response.",
  CODEX_AUTH_REQUIRED: "Sign in to ChatGPT using the dedicated bridge home.",
  CODEX_REQUEST_FAILED: "Codex account request failed; check login and CLI compatibility.",
  CODEX_TIMEOUT: "Codex request timed out; its local process was stopped.",
  STOPPED: "Bridge is stopping.",
  MQTT_OFFLINE: "MQTT is disconnected.",
  MQTT_FAILED: "MQTT operation failed; check TLS, broker credentials and topic permissions.",
  MQTT_TIMEOUT: "MQTT publish timed out; its connection was closed.",
  LOG_FAILED: "Bridge log could not be written safely.",
  OPERATION_FAILED: "Operation failed; check configuration and connectivity.",
});

export class BridgeError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? MESSAGES.OPERATION_FAILED);
    this.code = Object.hasOwn(MESSAGES, code) ? code : "OPERATION_FAILED";
  }
}

// Never print third-party error messages, response bodies, stderr or causes.
export function safeError(error) {
  const code = error instanceof BridgeError && Object.hasOwn(MESSAGES, error.code)
    ? error.code : "OPERATION_FAILED";
  return `${code}: ${MESSAGES[code]}`;
}
