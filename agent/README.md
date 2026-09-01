# Corin agent

The local half of the coach. It pairs this machine to one Discord account, then
holds a single outbound WebSocket to the backend so `/coach status` can answer
with real state. It never listens on a port and never holds a Discord, OpenAI, or
Riot key.

It reads League's Live Client API on `127.0.0.1:2999` and normalizes it into the
v2 session contract. A scripted fixture is still available behind the same
`GameDataProvider` trait for testing without the game.

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

## Reading League

The Live Client API exists only while a game is actually running, so its absence
says nothing on its own: League might be closed, or sitting in a lobby. The
process list settles which, and the two together give the three reported states.

| What the agent sees | League | Live API | Current game |
| --- | --- | --- | --- |
| API returns game data, `gameTime` above zero | Running | Available | Active |
| API returns 404 or unreadable data, which is what a loading screen looks like | Running | Unavailable | Inactive |
| Nothing on the port, but a League process exists | Running | Unavailable | Inactive |
| Nothing on the port and no League process | Not detected | Unavailable | Inactive |

Polling happens every five seconds in its own task, and `status()` reads the last
answer, so a slow local API can never delay a heartbeat.

Riot serves that API with a certificate signed by their own root, presented for
`localhost`. Verification is disabled for that one client and only towards
loopback, where there is nothing to intercept: reaching it already means having
the machine. The client that talks to the backend keeps full verification.

Only the three flags ever leave the machine. The real payload is around 60 KB of
player identity, items, runes and a full event log; the struct this agent
deserializes has exactly one field, so nothing else can leak by accident.

## Timing

Heartbeats go out every 20 seconds and the backend treats a device as connected
for 75 seconds after the last one, so two lost beats are survivable. Reconnects
back off from 2 up to 60 seconds with jitter, and a session that stays up for a
minute resets that budget.

## Starting with Windows

```sh
corin-agent autostart on     # from now on, start at login
corin-agent autostart off    # stop
corin-agent autostart show   # which of the two
```

Pairing offers this once, since a coach that only runs when you remember to
start it is a coach you stop using. `corin-agent reset` removes the entry along
with the credential.

It is a per-user `Run` key, so no administrator rights, nothing installed, and
nothing left behind but one registry value pointing at wherever the binary sits.

The entry passes `--background`, which hides the console window rather than
freeing it. Freeing it would invalidate stdout, and Rust panics when a print
fails, so the agent would die on its first line: a failure that only ever happens
at login, where nobody is watching. The window still flashes for an instant; a
tray build is what removes that for good.
