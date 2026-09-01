# Contracts

- [`pairing-exchange-v1.schema.json`](pairing-exchange-v1.schema.json) defines the agent's one-time pairing request.
- [`agent-session-v1.schema.json`](agent-session-v1.schema.json) defines authenticated `hello` and `heartbeat` messages carrying the three status flags.
- [`agent-session-v2.schema.json`](agent-session-v2.schema.json) adds the normalized current game beside those same flags. Agents send v2; the Worker still accepts v1.

Rules:

1. Every message has `version`, `type`, `requestId`, and a typed payload.
2. Backward-compatible additions increment a minor contract version; breaking changes require a new version and migration window.
3. Generate or test TypeScript and Rust types against the same schema.
4. Fixtures must be synthetically authored or redacted; never copy a player's raw API data into source control.

## What may not travel

Everything League exposes locally may be sent **except the identity of other
players**. Their summoner names and Riot IDs are dropped by the agent, at the
source, before anything is transmitted or stored. The device owner's own Riot ID
does travel: it is their own data.

This is not only about the roster. Riot's match events name people directly, so
`ChampionKill` and friends have every name resolved to the champion that person
was playing before the event leaves the machine. A name that cannot be resolved,
which happens when somebody has left the game, becomes `Unknown` rather than
being passed through: an unmatched name is exactly the case where a real one
could slip out.

Both sides are held by tests that fail if a forbidden field appears in a
serialized message.

## How two friends in one game recognise each other

Riot's local API exposes no game id, so v2 carries a `matchKey`: a hash of the
ten champions and their two teams, which every player in that match can see and
compute identically. Two devices reporting one key are in one game. The backend
already knows which Discord user owns each device, and each agent states which
champion its own owner is playing, so the pairing of person to champion is
assembled from data the backend holds rather than from anything the agents say
about each other.

## Version order when deploying

v2 messages are around 17 KB and the v1 Worker capped a message at 2 KB, so a v2
agent talking to a v1 Worker gets its session closed with `Invalid agent
message`. Deploy the Worker first, then publish the agent build.
