# LoL AI Voice Coach

The current implementation is the beginning of the first approved vertical slice: Discord pairing and owner-scoped status. Voice, OpenAI, PTT, and real League data are intentionally not implemented yet.

Read [`PROJECT.md`](PROJECT.md) for product intent and [`docs/README.md`](docs/README.md) for the architecture record.

## Local checks

```sh
npm install
npm run typecheck
npm test
```

## Provisioning checklist (not performed yet)

1. Create a Discord application and Bot; copy its Application ID, Bot Token, and Public Key.
2. Create a development Discord server (guild) and copy its Guild ID.
3. Authenticate Wrangler to the intended Cloudflare account.
4. The production D1 database is bound in [`wrangler.jsonc`](wrangler.jsonc). Its ID is an identifier, not a secret.
5. Add `DISCORD_PUBLIC_KEY` as a Cloudflare Worker secret. Do not commit it, the bot token, pairing codes, or device credentials.
6. In Cloudflare Workers & Pages, import this GitHub repository and enable Workers Builds for the production branch. Set its deploy command to `npm run deploy`; it applies any unapplied D1 migrations before deploying the Worker.
7. Set Discord's Interactions Endpoint URL to `https://<worker-domain>/interactions`.
8. Register the private-server commands:

   ```sh
   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run discord:register
   ```

The Worker endpoint validates Discord's Ed25519 signature before handling any interaction.
