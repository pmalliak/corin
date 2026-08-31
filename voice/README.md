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
