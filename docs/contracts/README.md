# Contracts

No implementation contracts exist yet. When the first vertical slice starts, this directory will contain versioned JSON Schema for:

- device WebSocket authentication and hello;
- heartbeat and normalized `AgentGameStatus`;
- pairing-code exchange result;
- error envelopes.

Rules:

1. Every message has `version`, `type`, `requestId`, and a typed payload.
2. Backward-compatible additions increment a minor contract version; breaking changes require a new version and migration window.
3. Generate or test TypeScript and Rust types against the same schema.
4. Fixtures must be synthetically authored or redacted; never copy a player’s raw API data into source control.
