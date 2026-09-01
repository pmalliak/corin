# ADR-003: A ChatGPT Project reads live state through a URL-borne secret

Status: accepted.

`GET /chatgpt/live-game` returns the live snapshot as plain text and authenticates with `CHATGPT_LIVE_TOKEN` carried in the query string, either as `?<secret>` or `?token=<secret>`. It is read-only, exposes only the account named by `MCP_DISCORD_USER_ID`, and accepts no other parameter from the caller.

Rationale: a ChatGPT Project can be instructed to read a link before it answers, but it cannot send an `Authorization` header and cannot speak MCP, so `/mcp` is unreachable from it. Putting `MCP_BEARER_TOKEN` in the Project instructions would store the MCP credential as plain text inside a third-party product, which is worse: that token reaches the same data through a channel that is not read-only by construction.

Consequence: the secret lands in browser history, in whatever fetches the page, and in request logs, so it is treated as the weakest of the four secrets. It is separate from `MCP_BEARER_TOKEN` and `COACH_SERVICE_TOKEN` so it can be rotated or removed alone, the route returns 404 until it is configured, responses carry `no-store` and `noindex`, and the page never contains a name: no other player's name exists in the snapshot, and the owner's own Riot ID is deliberately left out.
