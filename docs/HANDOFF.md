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
WebSocket with a 2 second heartbeat and jittered reconnect backoff. A revoked
device gets a 401 on connect, so the agent deletes its credential and asks for a
new pairing rather than retrying forever.

Game state comes from a `GameDataProvider`. The live implementation reads
League's Live Client API on `127.0.0.1:2999` every second in its own task,
and combines it with the process list, because that API only exists during a game
and its absence alone cannot tell a closed League from one sitting in a lobby.
Setting `CORIN_FIXTURE` swaps in a scripted provider for testing without the game.

Verified against a real game on 2026-08-31, including both transitions: leaving a
game dropped Live API to Unavailable while League stayed Running, and the next
game came back Active. Riot answers 404 on the loading screen, which the agent
reads as "League is there, data is not yet" rather than as an error.

Since contract v2 the agent sends the whole match, not just the flags: the owner's
champion stats, ability ranks, runes, items and score, every other player by
champion with their score and build, and the recent event log. Around 17 KB per
heartbeat, down from a 43 KB raw payload.

What never travels is the identity of other players. Their summoner names and
Riot IDs are dropped at the source, and match events have every name resolved to
a champion first, since Riot names people directly in `ChampionKill` and friends.
An unresolvable name becomes `Unknown` rather than being passed through. The
owner's own Riot ID does travel, being their own data.

Each message also carries a `matchKey`, a hash of the ten champions and their
teams. Two devices reporting the same key are in one game, which is how the
backend will be able to say who else from the server is in your match and on
what champion, without any agent naming another player.

`corin-agent autostart on` writes a per-user `Run` key, offered once at pairing
and removed by `reset`. That entry passes `--background`, which hides the console
window rather than freeing it: freeing invalidates stdout, and Rust panics when a
print fails, so the agent died on its first line. That only ever happened at
login, which is exactly where nobody is watching.

The release build is a single 2.3 MB executable. It is published to the
`corin-releases` R2 bucket and served by the Worker at `GET /download`, verified
by matching SHA-256 against the local build.

## Validation

```sh
npm run typecheck
npm test

cd agent && cargo test
```

All pass at this handoff point: 21 Worker tests, 42 agent tests, and `cargo clippy` is clean.

## The first slice is complete

League running locally, agent reading the Live Client API, backend knowing which
Discord user owns that agent, `/coach status` reporting it. Every acceptance
criterion in `plans/vertical-slice-1.md` holds except device revocation from
Discord, which is listed below.

## Not built yet

- Grouping devices by `matchKey`, so `/coach status` can say who else from the
  server is in your game. The key is transmitted and stored; nothing reads it yet,
  which needs a D1 column and an index rather than any protocol change.
- Signing for the agent binary, so Windows SmartScreen warns on first run.
- There is no way to revoke a device from Discord. The `devices.revoked_at`
  column exists and is honoured on every lookup, but only a manual D1 update
  sets it. `/coach devices` and `/coach disconnect` are the natural home for it.
- A tray build, so the agent stops being a console window. Autostart hides it,
  but it still flashes at login and can be closed by accident.
- Voice, OpenAI and push to talk remain out of scope until this slice is boring.
