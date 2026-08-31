# Development Handoff

Updated: 2026-08-31

## Repository and deployment

- Repository: `https://github.com/pmalliak/corin`
- Production Worker: `https://corin.panos-malliakoudis.workers.dev`
- Health check: `GET /health` returns `ok`.
- Cloudflare deployment: Workers Builds is connected to the `main` branch.
- D1 database: `lol-ai-voice-coach`, EU jurisdiction, binding `COACH_DB`.
- The initial migration has been applied: `users`, `devices`, and `pairing_codes` exist.
- `DISCORD_PUBLIC_KEY` is set as a Worker secret.

## External setup, done

- The Discord application is installed on the private guild.
- Interactions Endpoint URL points at `https://corin.panos-malliakoudis.workers.dev/interactions`.
- `/coach connect` and `/coach status` are registered as guild commands.

## Deployed and verified in production

- Signed Discord interactions endpoint. Unsigned requests get 401.
- `/coach connect` issues a single-use pairing code that lives ten minutes.
- `POST /agent/pair` exchanges that code for a device credential. Malformed bodies get 400, unknown codes get 401.
- `GET /agent/session` authenticates the credential and proxies an outbound WebSocket to a per-device hibernating Durable Object. Non-WebSocket requests get 426, bad credentials get 401.
- The session validates versioned `hello` and `heartbeat` messages, acknowledges each one, and keeps fresh device state available to `/coach status` for 75 seconds.
- Versioned JSON schemas are in `docs/contracts/`.

## Discord's three second deadline

Discord abandons an interaction that is not answered within three seconds, and a
status lookup crosses D1 plus the session Durable Object from whichever edge
Discord happens to hit. Both subcommands therefore acknowledge with a deferred
ephemeral response and edit the original reply afterwards through
`PATCH /webhooks/{application_id}/{token}/messages/@original`. A failure inside
that follow-up still edits the reply, so a command never hangs on "thinking".

The status lookup also reads D1 once instead of twice, since the device row it
needs is the same row the old status query read.

## Validation

```sh
npm run typecheck
npm test
```

Both pass at this handoff point.

## Not built yet

- The Rust fixture-mode agent. The protocol it must speak is live and exercised
  by a Node smoke script, so the agent is the last piece of the first slice.
- There is no way to revoke a device. The `devices.revoked_at` column exists and
  is honoured on every lookup, but no command sets it.
- Voice, OpenAI, push to talk, and real League data remain out of scope.
