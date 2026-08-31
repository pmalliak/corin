# Development Handoff

Updated: 2026-08-31

## Repository and deployment

- Repository: `https://github.com/pmalliak/corin`
- Production Worker: `https://corin.panos-malliakoudis.workers.dev`
- Health check: `GET /health` returns `ok`.
- Cloudflare deployment: Workers Builds is connected to the `main` branch.
- D1 database: `lol-ai-voice-coach`, EU jurisdiction, binding `COACH_DB`.
- The initial migration has been applied: `users`, `devices`, and `pairing_codes` exist.

## Implemented locally and deployed

- Signed Discord interactions endpoint: `POST /interactions`.
- `/coach connect` and `/coach status` command handling.
- D1 user/device/pairing schema and pairing-code repository.
- Generated Cloudflare runtime types.

## Validation

```sh
npm run typecheck
npm test
```

Both pass at this handoff point.

## Next external setup step

Create/configure the Discord application, then provide its Application ID, Public Key, and private Discord Guild ID. Never share the Discord bot token in chat or commit it. Set the public key in Cloudflare before configuring Discord's Interactions Endpoint URL to:

```text
https://corin.panos-malliakoudis.workers.dev/interactions
```

Then register `/coach connect` and `/coach status` for the private guild.

## In progress locally (not yet deployed)

- `POST /agent/pair` exchanges a single-use pairing code for a device credential.
- `GET /agent/session` validates that credential and proxies an outbound WebSocket to a per-device hibernating Durable Object.
- The session accepts small, versioned `hello` and `heartbeat` status messages, validates them, and makes fresh state available to `/coach status` for 75 seconds.
- Versioned JSON schemas are in `docs/contracts/`.
- The Rust fixture-mode agent is still not built.
