# Voice host

The Discord voice side of Corin. It lives outside the Worker for one hard
reason: Discord voice carries audio as RTP over **UDP**, and Cloudflare Workers
open TCP only. No amount of configuration gets voice into a Worker.

It is the same Discord application the Worker already serves. The Worker keeps
answering slash commands on its interactions endpoint; this process logs in to
the gateway with the bot token. One bot, two connections, no conflict.

Everything here is outbound. No inbound port, no public address, so it runs the
same behind a home router as on a server.

## Where the secrets go

`voice/.env`, copied from [`.env.example`](.env.example). The root
`.gitignore` ignores every `.env`, so it cannot reach git.

| Variable | Needed from | Notes |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | phase A | Developer Portal, the existing Corin app, Bot. The Worker never sees this. |
| `DISCORD_GUILD_ID` | phase A | The private server. |
| `OPENAI_API_KEY` | phase B | A project key from `platform.openai.com`, restricted, model capabilities Write. Not a ChatGPT subscription. |
| `CORIN_WORKER_URL` | phase D | Where the coach reads real game state. |

Two places these must never go: a Cloudflare Worker secret, since the Worker
never calls OpenAI, and the Rust agent, which is handed to other people.

## Checking them

```sh
cd voice
npm install
npm run check
```

Unit tests run on Node's own test runner, so they need no dependency:

```sh
npm test
```

`check` asks each service directly, because the only proof a credential works is
the service saying so. A key can be correctly formatted, in the right file, and
still be revoked, scoped read only, or on an account with no credit. Each row
passes or fails on its own, so a credential you have not created yet does not
hide the ones that already work.

## Where this runs

On a development machine while it is being built. In production it belongs on a
small VPS rather than a gaming PC, because the OpenAI Realtime socket carries
uncompressed PCM16 at 24 kHz in both directions, roughly half a megabit each
way per active conversation. That is nothing in a datacenter and it is real
contention on a home upstream during a game.

## Where the coach may go

It joins the voice channel holding the most people **that it is allowed to
enter**, follows them if they move, and leaves when the last one does.

Allowed means Discord permissions: View Channel, Connect and Speak. Give those
to one channel only and that is the only place the coach can ever appear; take
Connect away from a channel and it stops entering it. No restart, no deploy,
and it is set in the same place as every other permission on the server. That
is the same choice the Worker already makes about who may run `/coach`.

`COACH_CHANNEL_ID` pins it to one channel outright, for when a permission is
too blunt an instrument.

Only one host may run at a time. Two processes sharing a bot token do not
queue, they steal the voice connection from each other, and the symptom is
wrong behaviour rather than an error: an abandoned echo instance once answered
a question by playing the asker their own voice back. A second start is refused
against `.corin.lock`, and a lock left by a crashed process is taken over.

## Staying up

`@discordjs/ws` attaches an error handler to its gateway socket only when it
runs shards in worker threads. In the single process mode used here, a reset
connection arrives as an unhandled `error` event, which ends the process. That
is not theoretical: the host died on its first idle night, logged in with
nobody in a channel, from `ECONNRESET`.

`resilience.ts` therefore logs transient network faults and carries on, since
the gateway reconnects by itself, and exits on anything else so that a real
defect restarts clean instead of running on in an unknown state. `compose.yaml`
sets `restart: unless-stopped` for that second case.

## Running it on a server

```sh
docker compose up -d --build
docker compose logs -f
```

The image is `node:24-alpine` with nothing added to it. No compiler, no python,
no build tools, because every dependency is pure JavaScript: `opusscript` for
Opus and Node's own crypto for the `aes-256-gcm` Discord now expects. The native
Opus binding has no prebuild for Node 24 and wants Visual Studio Build Tools to
compile, and it buys nothing: pure JavaScript decodes a continuous stream for
0.2% of one core and encodes for 0.5%, so a two core server has room for far
more speakers than a private server will ever hold.

There is no build step, since Node 24 runs the TypeScript directly, and no port
is exposed, since every connection this process makes is outbound.

`.env` is excluded from the image by `.dockerignore` and injected at run time by
`compose.yaml`, so no key is ever baked into a layer.

## The game link

The coach can see the asker's match. When a question is about what is happening
right now, the model calls one tool and answers from what comes back:

```
Κόριν, τι έχω χτίσει μέχρι τώρα;
  → Runic Compass, Malignance και Sorcerer's Shoes.
```

The chain is: the agent reports the match to the Worker over its existing
WebSocket, the Worker keeps it in the device's Durable Object, and this process
reads it over HTTPS at `GET /coach/state` with `COACH_SERVICE_TOKEN`. That token
is not a device credential, because the coach speaks for every paired player at
once and no single device should be able to do that. Without the token
configured the route does not exist, so a deployment that has not been given one
cannot be probed for anybody's game.

Discord identifies the speaker, so the coach reads the match belonging to the
person who asked and nobody else. The 17 KB heartbeat is trimmed to under 1.5 KB
before it reaches the model: names of items rather than their prices and slots,
ability ranks as "Q5", allies and enemies split by the asker's own side.
