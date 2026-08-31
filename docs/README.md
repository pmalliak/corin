# Project Knowledge Index

`PROJECT.md` is the canonical product brief. Do not change product scope or requirements without updating it first.

This directory records the decisions and implementation context derived from that brief so a new contributor or model can orient quickly.

| Read first | Purpose |
| --- | --- |
| [`../PROJECT.md`](../PROJECT.md) | Canonical product requirements and boundaries. |
| [`architecture/v1.md`](architecture/v1.md) | Approved V1 target architecture, stack, trust boundaries, and risks. |
| [`plans/vertical-slice-1.md`](plans/vertical-slice-1.md) | The only implementation milestone currently authorized. |
| [`contracts/README.md`](contracts/README.md) | Contract ownership and versioning rules. |
| [`decisions/`](decisions/) | Short architecture decision records (ADRs). |

## Documentation rules

1. Keep `PROJECT.md` as the source of truth for product intent.
2. Add an ADR before changing a consequential architectural decision.
3. Version all agent/backend messages and schemas in `packages/contracts` once code exists.
4. Update the active implementation plan and relevant ADR when a decision, risk, or milestone changes.
5. Never put tokens, pairing codes, device credentials, personally identifying game data, or raw production payloads in this directory.
