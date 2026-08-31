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

## Immediate next step

Create/configure the Discord application, then provide its Application ID, Public Key, and private Discord Guild ID. Never share the Discord bot token in chat or commit it. Set the public key in Cloudflare before configuring Discord's Interactions Endpoint URL to:

```text
https://corin.panos-malliakoudis.workers.dev/interactions
```

Then register `/coach connect` and `/coach status` for the private guild. The fixture-mode local agent and device WebSocket session are not built yet.
