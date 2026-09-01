# LoL AI Voice Coach

The first vertical slice works end to end: a player pairs one PC from Discord, a local agent reads League's Live Client API, and `/coach status` reports that player's own game state. Voice, OpenAI and push-to-talk are intentionally not implemented yet, and the agent now reports the full match state, not only the status flags.

Read [`PROJECT.md`](PROJECT.md) for product intent and [`docs/README.md`](docs/README.md) for the architecture record.

## Local checks

```sh
npm install
npm run typecheck
npm test
```

## Provisioning checklist (completed)

1. Create a Discord application and Bot; copy its Application ID, Bot Token, and Public Key.
2. Create a development Discord server (guild) and copy its Guild ID.
3. Authenticate Wrangler to the intended Cloudflare account.
4. The production D1 database is bound in [`wrangler.jsonc`](wrangler.jsonc). Its ID is an identifier, not a secret.
5. Add `DISCORD_PUBLIC_KEY` as a Cloudflare Worker secret. Do not commit it, the bot token, pairing codes, or device credentials.
6. In Cloudflare Workers & Pages, import this GitHub repository and enable Workers Builds for the production branch. Set its deploy command to `npm run deploy`; it applies any unapplied D1 migrations before deploying the Worker.
7. Set Discord's Interactions Endpoint URL to `https://<worker-domain>/interactions`.
8. Restrict where the coach can be used from the guild itself: Server Settings, Integrations, the Corin app, Command Permissions. Channels and roles belong there rather than in this config, so they change without a deploy.
9. Register the private-server commands (`/coach setup`, `/coach connect`, `/coach status`). Rerun this whenever a subcommand is added:

   ```sh
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run discord:register
   # PowerShell: $env:DISCORD_APPLICATION_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="..."; npm run discord:register
   ```

The Worker endpoint validates Discord's Ed25519 signature before handling any interaction. `/coach connect` and `/coach status` reply with a deferred ephemeral response and edit it once the work finishes, because Discord drops any interaction left unanswered for three seconds. `/coach setup` is static, so it answers in the first response.

## Commands

| Command | What the member gets |
| --- | --- |
| `/coach setup` | The whole install guide in one embed: a download button, six numbered steps, what the agent can and cannot see, and the failures worth knowing about. |
| `/coach connect` | A single-use pairing code that lives ten minutes. |
| `/coach status` | Agent, League, Live API and current game, each with an indicator. During a game it adds champion, score, CS per minute, gold, level and both rosters by champion. |

Every reply is ephemeral, so the channel stays quiet however many people are pairing. The command is registered as guild-install, guild-context only, and where it may be used is left to the guild's own command permissions.

## Agent protocol (live)

`POST /agent/pair` exchanges a valid pairing code for a device credential. The agent then opens `GET /agent/session` as an outbound WebSocket with `Authorization: Bearer <credential>` and sends the versioned `hello`/`heartbeat` messages defined in [`docs/contracts/`](docs/contracts/).

## ChatGPT web (MCP)

The Worker also serves a read-only remote MCP endpoint at `https://<worker-domain>/mcp`. It exposes one tool, `get_my_live_game`, which can read only the Discord account selected by the `MCP_DISCORD_USER_ID` Worker secret. It never accepts a user ID, device credential, or query from the MCP client. The endpoint requires `Authorization: Bearer <MCP_BEARER_TOKEN>`.

Set a long random `MCP_BEARER_TOKEN` as a Worker secret and as the `MCP_BEARER_TOKEN` environment variable on the machine running Codex. In Codex's MCP server configuration, use that environment-variable name in **Bearer token env var**. Restart Codex after setting the local environment variable, then reconnect to the Worker’s `/mcp` URL.

## ChatGPT Project (no MCP)

A ChatGPT Project can be told to read a link before it answers, but it cannot send an `Authorization` header and it cannot speak MCP, so `/mcp` is out of reach for it. `GET /chatgpt/live-game` is the same read-only state as a plain-text page, with the secret in the URL:

```
https://<worker-domain>/chatgpt/live-game/<CHATGPT_LIVE_TOKEN>
https://<worker-domain>/chatgpt/live-game?<CHATGPT_LIVE_TOKEN>
```

The path form is the one to hand to a reader that rewrites URLs, because a query survives fewer hands than a path does. All of these are the same secret: `?<secret>`, `?<secret>=`, which is what a fetcher produces when it parses the first form and writes it out again, and `?token=<secret>` for typing it by hand. A parameter appended after the secret is ignored rather than treated as a wrong secret, so a cache-buster like `&t=17` is safe to add. The page reads only the account named by `MCP_DISCORD_USER_ID`, takes no account or query from the caller, and can change nothing. It answers `text/plain` with `cache-control: no-store`, and deliberately no `x-robots-tag`: a URL nobody can reach without the secret is not something a crawler can index, and that header is read by the very fetchers this page exists for.

```sh
npx wrangler secret put CHATGPT_LIVE_TOKEN   # 32+ random URL-safe characters: letters, digits, - and _
```

It is a separate secret from `MCP_BEARER_TOKEN` on purpose: rotating or removing it touches nothing else, and without it configured the route returns 404, so a deployment that has not been given one cannot be probed. A secret in a URL is weaker than one in a header, because it lands in browser history, in whatever fetches the page, and in request logs. That is the deliberate trade for a client with nowhere to put a credential. Rotate it by putting a new value in the secret and updating the Project guideline.

### A project instruction cannot make it fetch

ChatGPT opens links a person put in the conversation. A link that lives in a project instruction is not that, and is refused before the request is made, which is a sound defence against instructions that send a model to an arbitrary URL. So the guideline below works when the link is pasted into the chat, and the model will not fetch it on its own.

For a model that calls it by itself, the endpoint also describes itself as an action at `GET /chatgpt/openapi.json`. In the GPT builder: **Create a GPT**, **Configure**, **Create new action**, **Import from URL** with `https://<worker-domain>/chatgpt/openapi.json`, then **Authentication**, **API Key**, **Auth Type: Bearer**, and paste `CHATGPT_LIVE_TOKEN`. The secret then travels in the `Authorization` header rather than in a URL, which is the strongest of the three ways in. The schema names its own server from whatever domain served it and carries no secret.

The same report comes back as `{"report": "..."}` for a caller that sends `Accept: application/json`, which is what the action declares.

Paste this into the Project's instructions:

> Before answering anything about my current League of Legends game, fetch `https://<worker-domain>/chatgpt/live-game/<CHATGPT_LIVE_TOKEN>` and base your answer only on what that page says. It is a live read-only snapshot of my own game. If it says I am not in a game, say so instead of describing a match. Never invent champions, items, scores or events that are not on the page, and re-fetch it whenever I ask about the current state, because it changes every second.

## Private mobile coach

`GET /mobile` serves a small phone-friendly chat app. It requires `APP_ACCESS_TOKEN`, which the player enters locally and which is checked by the Worker before a request is processed. The Worker reads the configured live game state and calls the Responses API server-side with `OPENAI_API_KEY`; this key is never sent to the browser. `OPENAI_MODEL` optionally overrides the default `gpt-5-mini`.

For local development, copy `.dev.vars.example` to `.dev.vars` and set `MCP_DISCORD_USER_ID`. For the Worker, set it as a secret with `npx wrangler secret put MCP_DISCORD_USER_ID`.

## Local agent

[`agent/`](agent/) is the Windows-first Rust agent that speaks that protocol. It reads League's Live Client API on `127.0.0.1:2999` and sends the whole match: the owner's champion stats, ability ranks, runes, items and score, every other player by champion with their score and build, and the recent event log.

What never leaves the machine is the identity of other players. Their summoner names and Riot IDs are dropped at the source, and match events have every name resolved to a champion first. See [`docs/contracts/`](docs/contracts/) for the rule and the tests that hold it.

```sh
cd agent
cargo test
cargo build --release
```

The release build is a single self-contained 2.7 MB executable with no runtime to install beside it, and it only ever makes outbound connections, so Windows never asks for a firewall exception. It is built for the windows subsystem, so a login goes straight to the tray with no console window on the way, and a console appears only where somebody is reading one: a terminal command, or the pairing prompt on a first double-click.

The binary Windows starts at login is a copy under `%LOCALAPPDATA%Corin`, not the one in `agent/target/release`, because a startup entry pointing into a build directory breaks as soon as that directory moves. `npm run agent:install` builds, installs and restarts it in one step.

## Distributing the agent

The Worker serves the current build from an R2 bucket at `GET /download`, so a friend needs one link on this domain rather than a releases page. Publishing a new build is one command:

```sh
npx wrangler r2 object put corin-releases/corin-agent.exe --file agent/target/release/corin-agent.exe --content-type application/octet-stream --remote
```

The binary is unsigned, so Windows SmartScreen shows "Windows protected your PC" on first run and the user has to choose "More info" then "Run anyway". Removing that prompt needs a paid code signing certificate.
