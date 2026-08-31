# Contracts

- [`pairing-exchange-v1.schema.json`](pairing-exchange-v1.schema.json) defines the agent's one-time pairing request.
- [`agent-session-v1.schema.json`](agent-session-v1.schema.json) defines authenticated `hello` and `heartbeat` WebSocket messages.

Rules:

1. Every message has `version`, `type`, `requestId`, and a typed payload.
2. Backward-compatible additions increment a minor contract version; breaking changes require a new version and migration window.
3. Generate or test TypeScript and Rust types against the same schema.
4. Fixtures must be synthetically authored or redacted; never copy a player’s raw API data into source control.
