# ADR-001: Cloudflare hosts the control plane

Status: proposed.

Use Cloudflare Workers for HTTP endpoints and Discord interactions, D1 for persistent identity records, and a hibernating Durable Object per device for inbound agent WebSockets and latest ephemeral state.

Rationale: V1 needs low-operations public endpoints plus reliable outbound-only device connectivity, not a general server fleet.

Consequence: the future Discord voice/media process is separate because Discord voice requires UDP media transport, which Workers do not expose.
