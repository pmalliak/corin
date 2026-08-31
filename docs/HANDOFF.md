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
- `/coach setup`, `/coach connect` and `/coach status` are registered as guild commands, guild install and guild context only.
- Which channels and roles may use `/coach` is set in the guild under Server Settings, Integrations, Command Permissions. The Worker deliberately does not second-guess that, so there is no channel list in the config.

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
Discord happens to hit. The two subcommands that touch storage therefore use a deferred
ephemeral response and edit the original reply afterwards through
`PATCH /webhooks/{application_id}/{token}/messages/@original`. A failure inside
that follow-up still edits the reply, so a command never hangs on "thinking".

The status lookup also reads D1 once instead of twice, since the device row it
needs is the same row the old status query read.

## What Discord shows

Every reply is an embed built in `src/messages.ts`, so wording and colour live in
one place and `src/app.ts` only picks which one to send. `/coach status` goes
green when the agent is connected, amber when the device is paired but silent,
grey when nothing is paired, and every row carries its own indicator.

`/coach setup` is the whole install guide: a download button pointing at this
Worker's `/download`, six numbered steps from downloading the agent to seeing
**Agent: Connected**, a plain statement of what the agent can and cannot see, and
the four failures worth naming. It holds no state, so it answers in the first
response instead of deferring.

## The local agent

`agent/` holds the Rust agent. It pairs once, stores the device credential in the
Windows Credential Manager through the `keyring` crate, and holds one outbound
WebSocket with a 20 second heartbeat and jittered reconnect backoff. A revoked
device gets a 401 on connect, so the agent deletes its credential and asks for a
new pairing rather than retrying forever.

Game state comes from a `GameDataProvider`. Only the fixture implementation
exists; `CORIN_FIXTURE=active` pins it to "in a game" for one-shot checks, and
the default walks from nothing running to in game, one step per heartbeat. The
real Live Client API provider is the next thing to write and goes behind the
same trait.

The release build is a single 2.3 MB executable. It is published to the
`corin-releases` R2 bucket and served by the Worker at `GET /download`.

## Validation

```sh
npm run typecheck
npm test

cd agent && cargo test
```

All pass at this handoff point: 14 Worker tests, 20 agent tests.

## Not built yet

- The real Live Client API provider. Everything else in the first slice works.
- Signing for the agent binary, so Windows SmartScreen warns on first run.
- There is no way to revoke a device from Discord. The `devices.revoked_at`
  column exists and is honoured on every lookup, but only a manual D1 update
  sets it.
- Voice, OpenAI, push to talk, and real League data remain out of scope.
