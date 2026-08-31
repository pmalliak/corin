# First Vertical Slice: Paired Agent Status

Status: in progress.

## Outcome

With the agent running in fixture mode on macOS (and later real mode on Windows), a Discord user can pair one device and `/coach status` reports that user’s agent connectivity and League/game status. No voice, OpenAI, proactive advice, historical data, or long-term game storage is included.

## Acceptance criteria

- `/coach connect` produces a short-lived, single-use code visible only to its Discord user.
- The fixture-mode agent redeems the code, receives a device credential, reconnects after restart, and never exposes a listening port.
- A second redemption or expired code fails safely.
- `/coach status` is owner-scoped and reports `Connected/Disconnected`, `League Running/Not detected`, `Live API Available/Unavailable`, and `Game Active/Inactive`.
- The Discord response never reports another user’s device/game state.
- A revoked device cannot reconnect and no longer contributes status.
- Tests cover the pairing lifecycle, authorization boundary, status expiry, and fixture provider transitions.

## Ordered work

1. Scaffold the monorepo, formatter/linter/test configuration, environment validation, documentation index, and CI checks.
2. Define versioned contracts and redacted fixtures before Worker or agent logic.
3. Create D1 migrations for users, devices, and pairing codes, including uniqueness and expiry/consumption constraints.
4. Implement the Worker interaction endpoint: signature verification, `/coach connect`, and owner-scoped `/coach status`.
5. Implement the device upgrade gate and per-device Durable Object: authenticated hello, heartbeat, latest status, socket-close handling, and TTL expiry.
6. Implement the Rust agent shell with configuration, secure credential storage abstraction, reconnect loop, and fixture provider.
7. Implement the pairing exchange and status publisher, then prove the end-to-end flow locally and against a Cloudflare development deployment.
8. Add the real Live Client provider behind the same interface; run it only on Windows with League and capture no raw production data in the repository.
9. Add device revocation/status commands only to the extent needed to prove revocation; defer device-management UX polish.

## Explicit exclusions

- Joining Discord voice channels, receiving or playing audio.
- OpenAI calls, prompts, tools, or credentials.
- Global hotkeys/PTT (define the contract later; do not capture microphone audio in this slice).
- Full game-state ingestion beyond status and minimal fixture validation.
- Riot Web API, analytics, historical storage, and proactive decisioning.

## Risks to retire during this slice

- Durable Object authentication/reconnection semantics and status TTL.
- Discord interaction signature validation and slash-command registration lifecycle.
- Secure device credential storage on Windows.
- Local Riot certificate handling and response compatibility on a real Windows installation.
