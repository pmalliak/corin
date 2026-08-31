# ADR-002: The local agent has explicit real and fixture providers

Status: proposed.

The agent is a Rust program whose `GameDataProvider` has two implementations: real League Live Client API and deterministic fixture data.

Rationale: development must be possible on macOS without League installed, while production remains a lightweight Windows-native agent.

Consequence: every backend status test and most agent behavior can run on macOS. A Windows machine with an active League game remains necessary for real-client compatibility verification.
