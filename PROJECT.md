# LoL AI Voice Coach — Project Brief

## Goal

Build a private Discord-based AI voice coach for League of Legends.

The initial target users are a small private Discord server with a few friends. Each player can optionally install a lightweight local Windows agent that reads their own current League of Legends game data from the local Live Client API.

The coach should live in Discord voice, answer spoken questions, and eventually provide proactive live coaching.

---

## Product Roadmap

### V1 — Interactive Voice Coach

The first usable version should support:

* Discord bot installed in a private Discord server.
* Bot can join a voice channel.
* Voice-to-voice conversation with the AI coach.
* Push-to-talk style activation so the coach knows when a player is talking to it.
* Identify which Discord user initiated the coach request.
* Associate each Discord user with their own local LoL Agent.
* Local LoL Agent reads current game data from the League Live Client API on localhost.
* No Riot Web API or historical match data in V1.
* AI receives only normalized/relevant game state, not arbitrary access to the user's PC.
* Questions can include:

  * champion abilities
  * ability cooldowns
  * items
  * current CS
  * KDA
  * current items
  * current game time
  * information about players/champions in the current match
  * questions using the player's current game context

Example:

Player:
"Coach, how much CS do I have?"

Coach:
"You have 142 CS at 19 minutes."

Player:
"Coach, what does Kindred's ultimate do?"

Coach gives a concise spoken explanation.

---

### V2 — Proactive Live Coach

Add proactive coaching based on live game events.

The local game-state pipeline should detect meaningful changes/events and feed them into a Coach Decision Engine.

Examples:

* objective timers
* large unspent gold
* important cooldown situations
* deaths
* item purchases
* level changes
* significant CS differences
* important game-state changes

The coach should not talk constantly.

Support modes such as:

* Silent
* Push-to-Talk
* Reactive
* Proactive

The proactive system should have throttling, cooldowns and event prioritization.

---

### V3 — Historical / Personal Analytics

Later integrate the official Riot Web API and historical match data.

Possible functionality:

* champion performance
* recent match analysis
* CS/min trends
* recurring mistakes
* deaths by game phase
* build performance
* personal improvement tracking

V3 is explicitly out of scope for the first implementation.

---

# High-Level Architecture

```text
                            Discord Server
                                  |
                           Discord Voice Bot
                                  |
                          Coach Backend/API
                         /        |         \
                        /         |          \
             OpenAI Realtime   User/Device   Game State
                               Mapping       Store
                                  |
                     authenticated WSS/HTTPS
                                  |
                +-----------------+-----------------+
                |                                   |
          Panos PC                             Friend PC
                |                                   |
        LoL Coach Agent                      LoL Coach Agent
                |                                   |
        localhost:2999                       localhost:2999
                |                                   |
        League Live API                     League Live API
```

---

# Local Agent

Each player who wants live game coaching installs a small local Windows application.

Responsibilities:

1. Detect whether League of Legends is running.
2. Access the League Live Client API locally.
3. Normalize relevant current-game information.
4. Authenticate to the Coach Backend.
5. Maintain an outbound-only secure connection.
6. Send state updates/events to the backend.
7. Report health/status information.

The agent must NOT expose localhost:2999 to the public internet.

The agent should never contain:

* Discord bot token
* OpenAI API key
* Riot Web API key

Those belong on the backend.

---

# Device Pairing

Pairing should happen once per device.

Suggested UX:

1. User runs `/coach connect` in Discord.
2. Backend creates a short-lived pairing code.
3. User enters the pairing code in the LoL Coach Agent.
4. Backend links:

```text
Discord User ID
      ↓
Player
      ↓
Device
```

5. Backend gives the agent a device-specific long-lived credential.
6. Future connections authenticate automatically.

Changing PC or adding a new PC requires a new pairing.

Users should eventually be able to manage their devices with commands such as:

```text
/coach devices
/coach disconnect
/coach status
```

---

# Identity Model

Discord User ID is the primary user identity for V1.

Example:

```text
DiscordUser
    |
    +--- Device A
    |
    +--- Device B
```

When a Discord user talks to the coach:

```text
Discord speaker ID
        ↓
Player mapping
        ↓
Connected device
        ↓
Current game state
```

The coach must never accidentally use another player's private game context.

---

# Networking / Security

Preferred architecture:

```text
Local Agent
     |
     | outbound WSS/HTTPS only
     ↓
Coach Backend
```

Do NOT expose League's localhost API externally.

Security requirements:

* TLS only.
* Device-specific credentials.
* Pairing codes must expire quickly.
* Pairing codes must be single-use.
* Device credentials should be revocable.
* Backend maps credentials to Discord users.
* Local API data should be normalized before being sent upstream.
* Do not give OpenAI arbitrary network or machine access.
* Never send secrets in prompts.
* Validate all client input.
* Rate-limit agent and Discord endpoints.

---

# LoL Data

V1 uses only the League Live Client API available from the local machine, typically through localhost.

Create an abstraction around game data rather than exposing raw LoL responses directly to the coach.

Suggested interface:

```text
GameDataProvider

getCurrentGame()
getCurrentPlayer()
getPlayers()
getRecentEvents()
getGameSummary()
```

Example normalized state:

```json
{
  "gameId": "current-game-id",
  "gameTimeSeconds": 1142,
  "player": {
    "champion": "Jinx",
    "level": 11,
    "kills": 4,
    "deaths": 1,
    "assists": 3,
    "cs": 142,
    "currentGold": 2140,
    "items": []
  },
  "participants": []
}
```

Avoid passing enormous raw API responses to the LLM.

---

# OpenAI Integration

Use OpenAI for the conversational/voice intelligence.

The OpenAI layer should NOT directly communicate with League's local API.

The Coach Backend provides controlled tools/context.

Conceptually:

```text
Player Voice
    ↓
OpenAI / Coach
    ↓
tool request if needed
    ↓
Coach Backend
    ↓
current normalized state
    ↓
OpenAI
    ↓
spoken answer
```

Possible internal tools:

```text
get_current_game_state()
get_current_player_state()
get_current_match_players()
get_recent_game_events()
```

V3 can later add:

```text
get_match_history()
get_champion_history()
get_player_trends()
```

---

# Voice / Push-to-Talk

For V1, prefer explicit Push-to-Talk activation rather than trying to infer whether normal group conversation is directed at the AI.

Desired behavior:

```text
Player presses coach PTT
        ↓
Audio is treated as a coach request
        ↓
Player releases PTT
        ↓
Coach processes request
        ↓
Coach responds in Discord voice
```

The exact implementation of the PTT trigger should be researched before committing to architecture.

Possible options include:

* hotkey handled by local agent
* Discord command/toggle
* desktop companion action

The system should support interruption of coach speech by a new user request if practical.

---

# Discord Commands

Initial command ideas:

```text
/coach setup
/coach connect
/coach status
/coach devices
/coach disconnect
/coach mode
/coach help
```

`/coach setup` should guide users through installing the local agent.

`/coach connect` creates the pairing process.

`/coach status` can show:

```text
Agent: Connected
League: Running
Live API: Available
Current game: Active
Coach mode: Push-to-Talk
```

Discord should act primarily as UI/control surface.

Business logic belongs in the backend.

---

# Data Storage

Keep V1 minimal.

Likely persistent data:

```text
User
- id
- discordUserId
- createdAt

Device
- id
- userId
- name
- credentialHash
- createdAt
- lastSeenAt
- revokedAt

PairingCode
- id
- discordUserId
- codeHash
- expiresAt
- consumedAt
```

Live game state does not necessarily need permanent persistence.

It can initially live in an in-memory/Redis-style state store keyed by device/user.

Historical storage is V3.

---

# Engineering Principles

* Keep Discord, LoL integration and AI integration decoupled.
* Do not make Discord bot classes the core business layer.
* Define interfaces around external systems.
* Keep secrets server-side.
* Prefer event-driven communication between agent and backend.
* Keep live game state small and normalized.
* Design V1 so V2 can subscribe to the same game-event stream.
* Avoid premature complexity.
* The first goal is an end-to-end usable vertical slice.

---

# First Milestone

The first milestone is NOT the complete voice coach.

Build this vertical slice first:

```text
League running locally
        ↓
Local Agent reads Live Client API
        ↓
Agent authenticates with Backend
        ↓
Backend knows which Discord user owns the agent
        ↓
/coach status
        ↓
Discord reports current League/game status
```

Once this works reliably, add voice/OpenAI.

---

# Out of Scope for Initial Milestone

Do not implement yet:

* Riot historical API
* analytics
* long-term game storage
* proactive coaching
* complex UI
* public multi-tenant SaaS
* billing
* mobile app
* matchmaking/statistical recommendations

---

# Codex Instructions

Before writing implementation code:

1. Read this entire document.
2. Inspect the existing repository.
3. Research current Discord voice/bot constraints, OpenAI Realtime API behavior, and League Live Client API behavior where implementation depends on current APIs.
4. Propose a concrete architecture and technology choices.
5. Identify any assumptions or technical risks.
6. Produce a phased implementation plan.
7. Only then begin implementing the first vertical slice.

Favor maintainable production-style code, but keep the MVP small.
