# Codex HA bridge

This fork publishes ChatGPT Codex account limits to Home Assistant over MQTT.
Setup, security boundaries and migration instructions are in `README.md`.

## Fork profile

```yaml
fork-profile:
  upstream: ofilis/codex-ha-bridge
  upstream-default-branch: main
  fork-owner: Zensqrl
  deploy-target: explicit host installation following README.md
  version-scheme: increment SemVer release version on main
  overlay: []
  verify:
    - npm run check
    - npm test
    - npm audit
  release: explicit user-authorized deployment; pushing main does not deploy
```

Use the global fork-maintenance skill for future fork work. The initial security
hardening is committed directly to `main` at the owner's explicit request.
No permanent fork-only overlay or automated upstream sync is currently needed.

## Development and security

- Install locked dependencies with `npm ci --ignore-scripts`.
- Keep OAuth credentials under a separately established Codex bridge login.
  Never copy, parse or mutate the desktop Codex credential file.
- Require verified MQTT TLS; permit plaintext only for an explicitly enabled
  loopback endpoint inside a separately encrypted tunnel.
- Preserve discovery identifiers and default topics unless migration is requested.
- Use dummy credentials and isolated loopback fixtures for tests. Real account,
  broker and Windows runtime acceptance are separate from local test success.
- Never commit `.env`, credentials, private keys, logs or real account responses.

## Backlog

Track this bounded effort as tasks in Todoist under
`Misc Side Projects / Smart Home`, using its established `SH` identifiers.
SH-06 covers local security hardening. SH-07 covers configuration and live
acceptance. Follow the global todoist-project-backlog skill for updates.
