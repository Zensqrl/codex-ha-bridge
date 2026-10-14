# Codex Home Assistant MQTT Bridge

Publish Codex usage limits to Home Assistant through MQTT Discovery. The bridge keeps the original sensor identifiers and topics while using a dedicated Codex login and verified MQTT TLS.

![Codex usage display](docs/images/pic-1.jpg)

## Requirements

- Node.js 22 or newer; CI targets Node 22 and 24.
- A native Codex CLI executable supporting `codex app-server` and `account/rateLimits/read`.
- Home Assistant MQTT integration and an MQTT broker with TLS enabled.
- A dedicated MQTT user and a **separate ChatGPT login for this bridge**.

The app-server schema was checked against Codex CLI **0.132.0**. Its command remains experimental. Later versions may change methods/response fields; run the checks before upgrading. Authenticated live operation must be verified for your account. API-key-only authentication does not supply the required ChatGPT quota data.

## Secure setup

1. Install the native Codex CLI through the official distribution and Node.js through a trusted source. On Windows, set `CODEX_EXECUTABLE` to the native `codex.exe` path if it is not on PATH; npm `.cmd`/`.bat` shims are deliberately unsupported.
2. Establish a separate login. Do **not** copy tokens or `auth.json` from your desktop Codex directory. On macOS/Linux:

   ```sh
   mkdir -m 700 "$HOME/.codex-ha-bridge"
   CODEX_HOME="$HOME/.codex-ha-bridge" codex -c 'cli_auth_credentials_store="file"' login
   chmod 600 "$HOME/.codex-ha-bridge/auth.json"
   ```

   On Windows, create a private directory accessible only to your Windows account. For the login command in a separate PowerShell session:

   ```powershell
   $env:CODEX_HOME = Join-Path $env:USERPROFILE ".codex-ha-bridge"
   New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
   codex -c 'cli_auth_credentials_store="file"' login
   ```

   Close that setup session afterward. Secure the directory using Windows ACLs. Credentials are stored in a dedicated file by Codex, which owns renewal; the bridge never parses that file or refreshes tokens itself.
3. Configure the broker's TLS listener and a user with write permission only on the chosen topics. For the default identifiers, the intended Mosquitto ACL is:

   ```text
   user codex_bridge
   topic write codex/usage/state
   topic write codex/usage/availability
   topic write homeassistant/sensor/codex_usage/+/config
   ```

   The Home Assistant MQTT user needs read access to these topics. Actual ACL enforcement must be tested against your broker; adding this file alone does not enable ACLs. No command subscriptions are required.
4. In this repository, run `npm ci --ignore-scripts`, copy `.env.example` to `.env`, and enter the broker settings. Use the broker DNS name appearing in its certificate. Supply `MQTT_CA_FILE` for a private CA instead of disabling verification. Keep `.env` private (`chmod 600 .env` on macOS/Linux; restrict its Windows ACL).
5. Run `npm start` in the foreground. Confirm fresh values in Home Assistant, certificate verification and topic restrictions before enabling startup persistence.

Never run the bridge as administrator/root. Treat the repository, native executable, CA files and dedicated Codex home as trusted local inputs. Keep the dedicated auth file out of this repository, backups shared with others, logs and support tickets.

## Configuration

Environment variables override `.env`. `.env` does not mutate the process environment or pass arbitrary variables to Codex.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MQTT_URL` | `mqtts://homeassistant.local:8883` | Broker endpoint; URL credentials, query strings and non-root paths are rejected. |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | empty | Dedicated broker credentials. |
| `MQTT_CA_FILE` | empty | Optional private CA PEM; path relative to the repository or absolute. |
| `MQTT_ALLOW_LOOPBACK_PLAINTEXT` | `false` | Explicitly permit `mqtt://localhost`, `127.0.0.1` or `[::1]` for a separately encrypted tunnel. Never enables remote plaintext. |
| `CODEX_BRIDGE_HOME` | `~/.codex-ha-bridge` | Absolute dedicated login directory; desktop home and overlapping/symlink aliases are refused. |
| `CODEX_EXECUTABLE` | `codex` on PATH | Native executable; a custom path must be absolute. |
| `CODEX_TIMEOUT_SECONDS` | `20` | App-server request deadline, 1–120 seconds. |
| `MQTT_TIMEOUT_SECONDS` | `10` | Connection/publish deadline, 1–60 seconds. |
| `MQTT_KEEPALIVE_SECONDS` | `30` | MQTT heartbeat, 5–120 seconds. |
| `SHUTDOWN_SECONDS` | `5` | Graceful MQTT shutdown budget, 1–30 seconds. |
| `POLL_SECONDS` | `60` | Poll interval after each cycle, 10–3600 seconds. |
| `MQTT_BASE_TOPIC` | `codex/usage` | State/availability prefix. |
| `HA_DISCOVERY_PREFIX` | `homeassistant` | Discovery prefix. |
| `DEVICE_ID` | `codex_usage` | Device identifier; use a different ID and base topic for additional instances. |
| `DEVICE_NAME` | `Codex Usage` | Device display name. |
| `BRIDGE_LOG_TO_FILE` | `false` | Write sanitized logs to `logs/bridge.log`, rotated at 5 MiB with three backups. |

Topic prefixes accept slash-separated letters, digits, underscores and hyphens. IDs accept these characters without slashes. Invalid numeric/Boolean settings fail instead of silently using defaults. TLS verification cannot be disabled; `NODE_TLS_REJECT_UNAUTHORIZED=0`, `DEBUG` and `NODE_DEBUG` are refused. Remove debug environment variables before starting, since third-party diagnostic output can expose protocol data.

## Upgrade from 0.1

- Stop the old instance before switching; keep old credentials out of the new configuration.
- Replace `mqtt://` with verified `mqtts://`, or an explicitly enabled loopback endpoint inside an encrypted tunnel.
- Replace the old `CODEX_HOME` bridge setting with `CODEX_BRIDGE_HOME` and perform the separate login described above.
- Remove `CODEX_ACCESS_TOKEN`, `CHATGPT_ACCOUNT_ID`, `CODEX_BACKEND_URL` and `CODEX_REFRESH_TOKEN_URL`; nonempty legacy values cause startup to fail. There is no automatic fallback to shared tokens or direct backend HTTP.
- Install locked dependencies with `npm ci --ignore-scripts`. The project now uses pinned MQTT.js; the zero-dependency claim no longer applies.
- Discovery unique IDs and default topics are unchanged. No sensor deletion/recreation should be necessary. Reset display times use the host timezone.

The bridge pins the app-server's ChatGPT backend origin, uses stdio with no network listener, and issues only `initialize`, `account/read` and `account/rateLimits/read` requests. It does not create Codex threads/turns, provide tools or request inference. Only a small explicit environment allowlist reaches the child; MQTT secrets, OpenAI token overrides and Node execution/debug overrides are excluded.

## Sensors and failure behavior

Primary and secondary sensor names refer to the windows supplied by Codex; their durations can vary by account. Check `primary_window_minutes` and `secondary_window_minutes` in the sensor attributes. Missing numeric values render as Home Assistant `unknown`, using its required null representation. Existing discovery unique IDs and entity IDs are preserved.

| Sensor | Payload field |
| --- | --- |
| Codex Primary Used / Remaining | `primary_used_percent` / `primary_remaining_percent` |
| Codex Primary Reset | `primary_reset_time` |
| Codex Secondary Used / Remaining | `secondary_used_percent` / `secondary_remaining_percent` |
| Codex Secondary Reset | `secondary_reset_time` |
| Codex Credits | `credits_balance` |
| Codex Plan | `plan` |
| Codex Limit Status | `rate_limit_reached_type` |

Discovery identifiers are retained for compatibility; actual window lengths are reported in `primary_window_minutes` and `secondary_window_minutes`. The `codex` bucket is selected explicitly when multiple limit buckets exist. Missing quota/credit values remain null and render unknown. Missing/unrecognized limit status stays `unknown`; only an explicit no-limit status with usable quota data produces `OK`. Account emails, IDs, credentials and raw responses are excluded from MQTT payloads.

Discovery, state and availability are retained and use QoS 1 acknowledgements. On each connection the bridge first publishes `offline`, then discovery and fresh state, then `online`. Errors mark it offline. A retained last will marks unexpected disconnections offline after broker detection; sensors also expire after three polling intervals. Broker failure itself may delay delivery until it recovers.

Only one poll runs at a time. Disconnected publishes fail immediately; timed-out connections and their queued messages are discarded. Reconnect attempts use capped exponential backoff with jitter, and each new connection fetches fresh state. Stalled Codex requests terminate their local child, allowing a later attempt to restart it. Foreground Ctrl+C/SIGTERM closes the child and attempts an offline publish within the shutdown budget.

Errors are fixed safe codes/messages, without raw response bodies, stderr, exception text or secrets. This intentionally limits diagnostic detail. Private CA and certificate errors are reported as `MQTT_FAILED`; login/CLI issues use `CODEX_AUTH_REQUIRED`, `CODEX_UNAVAILABLE`, `CODEX_PROTOCOL` or `CODEX_REQUEST_FAILED`.

## Windows background helpers

Test `.\run.ps1` first. `install-startup-task.bat` creates a per-user Startup shortcut and starts the hidden runner immediately, without elevation. The runner finds Node, enables rotated file logs and restarts stopped bridges after 30 seconds. A mutex prevents duplicate background runners for this checkout.

Use `.\stop-bridge.ps1` to stop the tracked runner and its child tree. It checks that the saved PID belongs to this checkout's PowerShell runner before stopping anything; abrupt termination relies on MQTT's last will. `uninstall-startup-task.ps1` stops that runner and removes the Startup shortcut. Neither command stops an independently launched foreground instance. Old 0.1 runners did not record PIDs: stop those manually before upgrading.

PowerShell syntax is checked locally, but Startup/COM, Windows ACLs, native CLI discovery and process-tree termination require a Windows smoke test before deployment.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit
```

The tests use dummy credentials, fake app-server responses and short-lived TLS broker fixtures bound only to `127.0.0.1`. OpenSSL with `req -addext` is required to generate temporary test certificates. Tests cover credential-file preservation, isolated child environment, protocol framing, timeouts, logging/rotation, payload filtering, TLS trust/hostname rejection, fragmented CONNACK, keepalive, last will, PUBACK loss, reconnect ordering and shutdown. They do not contact Home Assistant or OpenAI.

CI runs checks, tests and dependency audit on Node 22/24. Recheck the pinned dependency and lockfile on updates; auditing cannot prove the absence of malicious behavior. Before actual deployment, verify authenticated usage polling, broker ACLs and rendered Home Assistant sensors with the target account/broker and review the applicable Windows checks.

Example existing gauge:

```yaml
type: gauge
entity: sensor.codex_5h_used
name: Codex 5h
min: 0
max: 100
```

![Home Assistant entities](docs/images/pic-2.png)
