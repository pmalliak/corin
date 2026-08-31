# Corin agent

The local half of the coach. It pairs this machine to one Discord account, then
holds a single outbound WebSocket to the backend so `/coach status` can answer
with real state. It never listens on a port and never holds a Discord, OpenAI, or
Riot key.

Right now it reports a scripted fixture rather than League. The real Live Client
API provider lands behind the same `GameDataProvider` trait, so nothing else moves.

## Build

Needs a Rust toolchain and, on Windows, the MSVC linker from the Visual Studio
Build Tools.

```sh
cargo build --release
cargo test
```

The release binary is at `target/release/corin-agent.exe`, self-contained, no
runtime to install alongside it.

## Use

```sh
corin-agent                 # pair if needed, then report status
corin-agent 9C5510BD61EC    # pair with a code from /coach connect
corin-agent status          # is this machine paired
corin-agent reset           # forget the device credential
```

A friend only ever does the first one: double click, paste the code from
`/coach connect`, done. The credential is stored once and reused after that.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CORIN_BASE_URL` | the production Worker | point the agent at a local `wrangler dev` |
| `CORIN_DEVICE_NAME` | the machine hostname | how the device is labelled |
| `CORIN_FIXTURE` | a startup sequence | `active` pins "in a game", `offline` pins nothing running |
| `CORIN_NO_KEYRING` | unset | skip the OS keystore, forget the credential on exit |
| `RUST_LOG` | `corin_agent=info,warn` | log filter, try `corin_agent=debug` |

## Where the credential lives

In the OS keystore through the `keyring` crate: Windows Credential Manager,
Keychain on macOS, Secret Service on Linux. Not in a file, because it
authenticates this machine until the device is revoked.

If the backend rejects it, meaning the device was revoked, the agent deletes it
and asks for a fresh pairing rather than retrying forever.

## Timing

Heartbeats go out every 20 seconds and the backend treats a device as connected
for 75 seconds after the last one, so two lost beats are survivable. Reconnects
back off from 2 up to 60 seconds with jitter, and a session that stays up for a
minute resets that budget.
