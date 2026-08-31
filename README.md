# LoL AI Voice Coach

The first vertical slice works end to end: a player pairs one PC from Discord, a local agent reads League's Live Client API, and `/coach status` reports that player's own game state. Voice, OpenAI and push-to-talk are intentionally not implemented yet, and the agent reports status only, not the full game state.

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
| `/coach status` | Agent, League, Live API and current game, each with an indicator and a colour that follows the worst of them. |

Every reply is ephemeral, so the channel stays quiet however many people are pairing. The command is registered as guild-install, guild-context only, and where it may be used is left to the guild's own command permissions.

## Agent protocol (live)

`POST /agent/pair` exchanges a valid pairing code for a device credential. The agent then opens `GET /agent/session` as an outbound WebSocket with `Authorization: Bearer <credential>` and sends the versioned `hello`/`heartbeat` messages defined in [`docs/contracts/`](docs/contracts/).

## Local agent

[`agent/`](agent/) is the Windows-first Rust agent that speaks that protocol. It reads League's Live Client API on `127.0.0.1:2999` and reports whether League is running, whether that API answers, and whether a game is actually under way. Only those three flags leave the machine.

```sh
cd agent
cargo test
cargo build --release
```

The release build is a single self-contained 2.3 MB executable with no runtime to install beside it, and it only ever makes outbound connections, so Windows never asks for a firewall exception.

## Distributing the agent

The Worker serves the current build from an R2 bucket at `GET /download`, so a friend needs one link on this domain rather than a releases page. Publishing a new build is one command:

```sh
npx wrangler r2 object put corin-releases/corin-agent.exe --file agent/target/release/corin-agent.exe --content-type application/octet-stream --remote
```

The binary is unsigned, so Windows SmartScreen shows "Windows protected your PC" on first run and the user has to choose "More info" then "Run anyway". Removing that prompt needs a paid code signing certificate.
