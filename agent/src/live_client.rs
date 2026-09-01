//! Reads League's Live Client API on this machine and normalizes it.
//!
//! That API only exists while a game is actually running, so its absence says
//! nothing on its own: League might be closed, or sitting in champion select.
//! The process list settles which, and the two together give the three states
//! `/coach status` reports.
//!
//! Everything the API knows travels except the identity of other players. Their
//! summoner names and Riot IDs are dropped here, at the source, and the names
//! inside match events are resolved to champions before they can leave. The
//! device owner's own Riot ID travels, because it is their own data.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;

use crate::contract::{
    match_key, Ability, CurrentGameState, GameEvent, GameState, Item, LeagueState, LiveApiState, Participant, Player, Position, Snapshot,
    StatusPayload, Team,
};
use crate::provider::GameDataProvider;

const ALL_GAME_DATA: &str = "https://127.0.0.1:2999/liveclientdata/allgamedata";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Kept to what advice can use. A forty minute game accumulates hundreds.
const MAX_EVENTS: usize = 40;

/// Names as they appear in Task Manager. The first is the game itself, the rest
/// are the launcher, which counts as League being open but not in a game.
const LEAGUE_PROCESSES: [&str; 3] = ["League of Legends.exe", "LeagueClient.exe", "LeagueClientUx.exe"];

/// Polls in the background and keeps the latest answer ready, so a heartbeat
/// never waits on a request and a slow local API cannot stall the session.
pub struct LiveClientProvider {
    latest: Arc<Mutex<Snapshot>>,
}

impl LiveClientProvider {
    pub async fn start() -> anyhow::Result<Self> {
        let client = loopback_client()?;
        // Probed once before returning, so the session's opening hello carries the
        // real state instead of "nothing running" until the first tick lands.
        let latest = Arc::new(Mutex::new(probe(&client).await));
        let writer = Arc::clone(&latest);

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(POLL_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let next = probe(&client).await;
                let mut slot = writer.lock().expect("live status lock poisoned");
                if slot.status != next.status {
                    tracing::info!(status = ?next.status, "league status changed");
                }
                *slot = next;
            }
        });

        Ok(Self { latest })
    }
}

impl GameDataProvider for LiveClientProvider {
    fn snapshot(&self) -> Snapshot {
        self.latest.lock().expect("live status lock poisoned").clone()
    }

    fn name(&self) -> &'static str {
        "live client"
    }
}

/// Riot serves the Live Client API over TLS with a certificate signed by their own
/// root, presented for "localhost". Verification is turned off for this client and
/// this client only, which is safe here because the connection never leaves the
/// loopback interface: reaching it already means having the machine. The client
/// that talks to the backend keeps full verification.
fn loopback_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(REQUEST_TIMEOUT)
        .build()?)
}

async fn probe(client: &reqwest::Client) -> Snapshot {
    match client.get(ALL_GAME_DATA).send().await {
        Ok(response) if response.status().is_success() => match response.json::<RawGame>().await {
            Ok(raw) => normalize(raw),
            Err(error) => {
                tracing::warn!(%error, "live client answered with something unreadable");
                Snapshot::status_only(api_present_but_unusable())
            }
        },
        // The port answered but not with data, so the game is there and not ready.
        Ok(response) => {
            tracing::debug!(status = %response.status(), "live client not ready");
            Snapshot::status_only(api_present_but_unusable())
        }
        Err(_) if league_is_running() => Snapshot::status_only(api_present_but_unusable()),
        Err(_) => Snapshot::offline(),
    }
}

fn api_present_but_unusable() -> StatusPayload {
    StatusPayload {
        league: LeagueState::Running,
        live_api: LiveApiState::Unavailable,
        current_game: CurrentGameState::Inactive,
    }
}

fn league_is_running() -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system.processes().values().any(|process| {
        let name = process.name().to_string_lossy();
        LEAGUE_PROCESSES.iter().any(|candidate| name.eq_ignore_ascii_case(candidate))
    })
}

/// Turns Riot's payload into the contract, dropping every identity but the owner's.
fn normalize(raw: RawGame) -> Snapshot {
    let loading = raw.game_data.game_time <= 0.0;
    let status = StatusPayload {
        league: LeagueState::Running,
        live_api: LiveApiState::Available,
        current_game: if loading { CurrentGameState::Inactive } else { CurrentGameState::Active },
    };

    let Some(active) = raw.active_player.as_ref() else {
        return Snapshot::status_only(status);
    };
    // The active player appears again in the roster, which is the only place their
    // score lives. Riot has used both fields as the join key over time.
    let Some(own_row) = raw
        .all_players
        .iter()
        .find(|player| player.matches_identity(active))
    else {
        return Snapshot::status_only(status);
    };

    // Built before any name is dropped, since resolving events needs the mapping.
    let champion_by_name: HashMap<&str, &str> = raw
        .all_players
        .iter()
        .flat_map(|player| {
            [player.summoner_name.as_deref(), player.riot_id.as_deref()]
                .into_iter()
                .flatten()
                .map(|name| (name, player.champion_name.as_str()))
        })
        .collect();

    let mut lineup: Vec<(Team, &str)> = raw
        .all_players
        .iter()
        .map(|player| (player.team(), player.champion_name.as_str()))
        .collect();

    let game = GameState {
        match_key: match_key(&raw.game_data.game_mode, raw.game_data.map_name.as_deref(), &mut lineup),
        mode: raw.game_data.game_mode.clone(),
        map: raw.game_data.map_name.clone(),
        map_terrain: raw.game_data.map_terrain.clone(),
        time_seconds: raw.game_data.game_time,
        player: Player {
            champion: own_row.champion_name.clone(),
            riot_id: active.riot_id.clone().or_else(|| active.summoner_name.clone()),
            team: own_row.team(),
            position: own_row.position(),
            level: active.level.unwrap_or(own_row.level).max(1),
            kills: own_row.scores.kills,
            deaths: own_row.scores.deaths,
            assists: own_row.scores.assists,
            creep_score: own_row.scores.creep_score,
            ward_score: own_row.scores.ward_score,
            gold: active.current_gold.unwrap_or_default(),
            is_dead: own_row.is_dead,
            respawn_seconds: positive(own_row.respawn_timer),
            stats: active.champion_stats.clone(),
            abilities: abilities_of(active),
            runes: active.full_runes.clone().or_else(|| own_row.runes.clone()),
            summoner_spells: own_row.spells(),
            items: own_row.items(),
        },
        participants: raw
            .all_players
            .iter()
            .filter(|player| !std::ptr::eq(*player, own_row))
            .map(|player| Participant {
                champion: player.champion_name.clone(),
                team: player.team(),
                position: player.position(),
                level: player.level.max(1),
                kills: player.scores.kills,
                deaths: player.scores.deaths,
                assists: player.scores.assists,
                creep_score: player.scores.creep_score,
                ward_score: player.scores.ward_score,
                is_dead: player.is_dead,
                respawn_seconds: positive(player.respawn_timer),
                is_bot: player.is_bot,
                runes: player.runes.clone(),
                summoner_spells: player.spells(),
                items: player.items(),
            })
            .collect(),
        events: normalize_events(raw.events.as_ref(), &champion_by_name),
    };

    Snapshot { status, game: Some(game) }
}

/// Rewrites every player name in the event log to the champion they were playing.
/// Structures keep their own names; anything unrecognized becomes "Unknown" rather
/// than travelling, because an unmatched name is exactly the case where a real one
/// could slip out.
fn normalize_events(events: Option<&RawEvents>, champion_by_name: &HashMap<&str, &str>) -> Vec<GameEvent> {
    let Some(events) = events else { return Vec::new() };

    let resolve = |name: &String| -> String {
        if let Some(champion) = champion_by_name.get(name.as_str()) {
            return (*champion).to_owned();
        }
        if is_structure(name) {
            return name.clone();
        }
        "Unknown".to_owned()
    };

    let all = &events.events;
    all.iter()
        .skip(all.len().saturating_sub(MAX_EVENTS))
        .map(|event| GameEvent {
            id: event.event_id,
            name: event.event_name.clone(),
            time_seconds: event.event_time,
            killer: event.killer_name.as_ref().map(&resolve),
            victim: event.victim_name.as_ref().map(&resolve),
            assisters: event.assisters.iter().map(&resolve).collect(),
            recipient: event.recipient.as_ref().map(&resolve),
            dragon_type: event.dragon_type.clone(),
            stolen: event.stolen.as_ref().map(|value| value == "True" || value == "true"),
            kill_streak: event.kill_streak,
            turret: event.turret_killed.clone(),
            inhibitor: event.inhib_killed.clone(),
        })
        .collect()
}

/// Riot names map objects like `Turret_T1_C_05_A` or `Barracks_T2_L1`.
fn is_structure(name: &str) -> bool {
    const PREFIXES: [&str; 6] = ["Turret_", "Barracks_", "HQ_", "Minion_", "SRU_", "Obelisk"];
    PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn positive(value: f64) -> Option<f64> {
    (value > 0.0).then_some(value)
}

fn abilities_of(active: &RawActivePlayer) -> Vec<Ability> {
    let Some(abilities) = active.abilities.as_ref() else { return Vec::new() };
    let mut slots: Vec<Ability> = abilities
        .iter()
        .map(|(slot, ability)| Ability {
            slot: slot.clone(),
            name: ability.display_name.clone().unwrap_or_default(),
            rank: ability.ability_level.unwrap_or(0),
        })
        .collect();
    slots.sort_by(|left, right| left.slot.cmp(&right.slot));
    slots
}

// Riot's own shapes. Everything is optional: the API serves partial objects while
// a game loads, and a missing field must never take the agent down.

#[derive(Debug, Deserialize)]
struct RawGame {
    #[serde(rename = "gameData")]
    game_data: RawGameData,
    #[serde(rename = "activePlayer")]
    active_player: Option<RawActivePlayer>,
    #[serde(rename = "allPlayers", default)]
    all_players: Vec<RawPlayer>,
    events: Option<RawEvents>,
}

#[derive(Debug, Deserialize)]
struct RawGameData {
    #[serde(rename = "gameMode", default)]
    game_mode: String,
    #[serde(rename = "gameTime", default)]
    game_time: f64,
    #[serde(rename = "mapName")]
    map_name: Option<String>,
    #[serde(rename = "mapTerrain")]
    map_terrain: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawActivePlayer {
    #[serde(rename = "summonerName")]
    summoner_name: Option<String>,
    #[serde(rename = "riotId")]
    riot_id: Option<String>,
    level: Option<u8>,
    #[serde(rename = "currentGold")]
    current_gold: Option<f64>,
    #[serde(rename = "championStats")]
    champion_stats: Option<serde_json::Value>,
    #[serde(rename = "fullRunes")]
    full_runes: Option<serde_json::Value>,
    abilities: Option<HashMap<String, RawAbility>>,
}

#[derive(Debug, Deserialize)]
struct RawAbility {
    #[serde(rename = "abilityLevel")]
    ability_level: Option<u8>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawPlayer {
    #[serde(rename = "championName", default)]
    champion_name: String,
    #[serde(rename = "summonerName")]
    summoner_name: Option<String>,
    #[serde(rename = "riotId")]
    riot_id: Option<String>,
    #[serde(default)]
    team: String,
    #[serde(default)]
    position: String,
    #[serde(default = "one")]
    level: u8,
    #[serde(rename = "isDead", default)]
    is_dead: bool,
    #[serde(rename = "isBot", default)]
    is_bot: bool,
    #[serde(rename = "respawnTimer", default)]
    respawn_timer: f64,
    #[serde(default)]
    scores: RawScores,
    #[serde(default)]
    items: Vec<RawItem>,
    runes: Option<serde_json::Value>,
    #[serde(rename = "summonerSpells")]
    summoner_spells: Option<HashMap<String, RawSpell>>,
}

fn one() -> u8 {
    1
}

impl RawPlayer {
    fn matches_identity(&self, active: &RawActivePlayer) -> bool {
        let same = |mine: &Option<String>, theirs: &Option<String>| match (mine, theirs) {
            (Some(left), Some(right)) => !left.is_empty() && left == right,
            _ => false,
        };
        same(&self.riot_id, &active.riot_id) || same(&self.summoner_name, &active.summoner_name)
    }

    fn team(&self) -> Team {
        if self.team.eq_ignore_ascii_case("CHAOS") {
            Team::Chaos
        } else {
            Team::Order
        }
    }

    fn position(&self) -> Option<Position> {
        Some(match self.position.to_ascii_uppercase().as_str() {
            "TOP" => Position::Top,
            "JUNGLE" => Position::Jungle,
            "MIDDLE" => Position::Middle,
            "BOTTOM" => Position::Bottom,
            "UTILITY" => Position::Utility,
            _ => Position::None,
        })
    }

    fn items(&self) -> Vec<Item> {
        self.items
            .iter()
            .map(|item| Item {
                id: item.item_id,
                name: item.display_name.clone(),
                slot: item.slot,
                count: item.count.max(1),
                price: item.price,
                consumable: item.consumable,
            })
            .collect()
    }

    fn spells(&self) -> Vec<String> {
        let Some(spells) = self.summoner_spells.as_ref() else { return Vec::new() };
        let mut named: Vec<(&String, String)> = spells
            .iter()
            .filter_map(|(slot, spell)| spell.display_name.clone().map(|name| (slot, name)))
            .collect();
        named.sort_by(|left, right| left.0.cmp(right.0));
        named.into_iter().map(|(_, name)| name).collect()
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawScores {
    #[serde(default)]
    kills: u32,
    #[serde(default)]
    deaths: u32,
    #[serde(default)]
    assists: u32,
    #[serde(rename = "creepScore", default)]
    creep_score: u32,
    #[serde(rename = "wardScore")]
    ward_score: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct RawItem {
    #[serde(rename = "itemID", default)]
    item_id: u32,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(default)]
    slot: u8,
    #[serde(default = "one_u32")]
    count: u32,
    price: Option<u32>,
    #[serde(default)]
    consumable: bool,
}

fn one_u32() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
struct RawSpell {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawEvents {
    #[serde(rename = "Events", default)]
    events: Vec<RawEvent>,
}

#[derive(Debug, Deserialize)]
struct RawEvent {
    #[serde(rename = "EventID", default)]
    event_id: u32,
    #[serde(rename = "EventName", default)]
    event_name: String,
    #[serde(rename = "EventTime", default)]
    event_time: f64,
    #[serde(rename = "KillerName")]
    killer_name: Option<String>,
    #[serde(rename = "VictimName")]
    victim_name: Option<String>,
    #[serde(rename = "Assisters", default)]
    assisters: Vec<String>,
    #[serde(rename = "Recipient")]
    recipient: Option<String>,
    #[serde(rename = "DragonType")]
    dragon_type: Option<String>,
    #[serde(rename = "Stolen")]
    stolen: Option<String>,
    #[serde(rename = "KillStreak")]
    kill_streak: Option<u32>,
    #[serde(rename = "TurretKilled")]
    turret_killed: Option<String>,
    #[serde(rename = "InhibKilled")]
    inhib_killed: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthetic, in the shape the real API returns. Never a captured payload:
    /// those carry real people's names.
    fn sample() -> &'static str {
        r#"{
          "activePlayer": {
            "summonerName": "Owner",
            "riotId": "Owner#EUNE",
            "level": 11,
            "currentGold": 2140.5,
            "championStats": { "attackDamage": 120.0, "abilityHaste": 20.0 },
            "fullRunes": { "keystone": { "displayName": "Lethal Tempo" } },
            "abilities": {
              "Q": { "abilityLevel": 5, "displayName": "Switcheroo!" },
              "W": { "abilityLevel": 3, "displayName": "Zap!" },
              "Passive": { "displayName": "Get Excited!" }
            }
          },
          "allPlayers": [
            {
              "championName": "Jinx", "summonerName": "Owner", "riotId": "Owner#EUNE",
              "team": "ORDER", "position": "BOTTOM", "level": 11, "isDead": false, "isBot": false,
              "respawnTimer": 0.0,
              "scores": { "kills": 4, "deaths": 1, "assists": 3, "creepScore": 142, "wardScore": 3.5 },
              "items": [{ "itemID": 3866, "displayName": "Runic Compass", "slot": 0, "count": 1, "price": 400, "consumable": false }],
              "runes": { "keystone": { "displayName": "Lethal Tempo" } },
              "summonerSpells": { "summonerSpellOne": { "displayName": "Flash" }, "summonerSpellTwo": { "displayName": "Heal" } }
            },
            {
              "championName": "Ahri", "summonerName": "SomeoneElse", "riotId": "SomeoneElse#EUW",
              "team": "CHAOS", "position": "MIDDLE", "level": 10, "isDead": true, "isBot": false,
              "respawnTimer": 12.5,
              "scores": { "kills": 2, "deaths": 3, "assists": 4, "creepScore": 130 },
              "items": []
            }
          ],
          "events": { "Events": [
            { "EventID": 0, "EventName": "GameStart", "EventTime": 0.03 },
            { "EventID": 12, "EventName": "ChampionKill", "EventTime": 750.2,
              "KillerName": "SomeoneElse", "VictimName": "Owner", "Assisters": ["SomeoneElse"] },
            { "EventID": 13, "EventName": "TurretKilled", "EventTime": 800.0,
              "KillerName": "SomeoneElse", "TurretKilled": "Turret_T1_C_05_A", "Assisters": [] },
            { "EventID": 14, "EventName": "ChampionKill", "EventTime": 900.0,
              "KillerName": "AStrangerWhoLeft", "VictimName": "Owner", "Assisters": [] }
          ] },
          "gameData": { "gameMode": "CLASSIC", "gameTime": 1142.0, "mapName": "Map11", "mapTerrain": "Default" }
        }"#
    }

    fn normalized() -> Snapshot {
        normalize(serde_json::from_str::<RawGame>(sample()).unwrap())
    }

    #[test]
    fn a_running_game_normalizes_into_the_contract() {
        let game = normalized().game.expect("a game should be reported");

        assert_eq!(game.mode, "CLASSIC");
        assert_eq!(game.time_seconds, 1142.0);
        assert_eq!(game.player.champion, "Jinx");
        assert_eq!(game.player.kills, 4);
        assert_eq!(game.player.creep_score, 142);
        assert_eq!(game.player.gold, 2140.5);
        assert_eq!(game.player.items.len(), 1);
        assert_eq!(game.player.summoner_spells, vec!["Flash", "Heal"]);
        assert_eq!(game.participants.len(), 1, "the owner must not appear twice");
        assert_eq!(game.participants[0].champion, "Ahri");
    }

    #[test]
    fn the_owners_own_level_and_stats_come_from_the_active_player_block() {
        let player = normalized().game.unwrap().player;
        assert_eq!(player.level, 11);
        assert_eq!(player.stats.unwrap()["attackDamage"], 120.0);
    }

    #[test]
    fn abilities_carry_their_rank() {
        let abilities = normalized().game.unwrap().player.abilities;
        let q = abilities.iter().find(|ability| ability.slot == "Q").expect("Q should be there");
        assert_eq!(q.rank, 5);
        assert_eq!(q.name, "Switcheroo!");
    }

    #[test]
    fn events_name_champions_instead_of_people() {
        let events = normalized().game.unwrap().events;
        let kill = events.iter().find(|event| event.id == 12).unwrap();

        assert_eq!(kill.killer.as_deref(), Some("Ahri"));
        assert_eq!(kill.victim.as_deref(), Some("Jinx"));
        assert_eq!(kill.assisters, vec!["Ahri"]);
    }

    #[test]
    fn structures_keep_their_own_names() {
        let events = normalized().game.unwrap().events;
        let turret = events.iter().find(|event| event.id == 13).unwrap();
        assert_eq!(turret.turret.as_deref(), Some("Turret_T1_C_05_A"));
    }

    /// Somebody who left the game is no longer in the roster, so their name cannot
    /// be resolved. It must be dropped rather than passed through.
    #[test]
    fn an_unresolvable_name_becomes_unknown_rather_than_travelling() {
        let events = normalized().game.unwrap().events;
        let kill = events.iter().find(|event| event.id == 14).unwrap();
        assert_eq!(kill.killer.as_deref(), Some("Unknown"));
    }

    #[test]
    fn no_other_players_identity_survives_normalization() {
        let encoded = serde_json::to_string(&normalized().game.unwrap()).unwrap();

        assert!(!encoded.contains("SomeoneElse"), "another player's name leaked");
        assert!(!encoded.contains("AStrangerWhoLeft"), "a departed player's name leaked");
        assert!(encoded.contains("Owner#EUNE"), "the owner's own id should be kept");
    }

    #[test]
    fn the_match_key_is_present_and_stable() {
        let first = normalized().game.unwrap().match_key;
        let second = normalized().game.unwrap().match_key;
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
    }

    #[test]
    fn a_loading_screen_is_active_game_inactive_but_still_available() {
        let raw: RawGame = serde_json::from_str(r#"{"gameData":{"gameMode":"CLASSIC","gameTime":0.0},"allPlayers":[]}"#).unwrap();
        let snapshot = normalize(raw);

        assert_eq!(snapshot.status.live_api, LiveApiState::Available);
        assert_eq!(snapshot.status.current_game, CurrentGameState::Inactive);
        assert!(snapshot.game.is_none(), "there is no game to describe yet");
    }

    #[test]
    fn a_payload_without_the_active_player_reports_status_only() {
        let raw: RawGame = serde_json::from_str(r#"{"gameData":{"gameMode":"CLASSIC","gameTime":30.0},"allPlayers":[]}"#).unwrap();
        assert!(normalize(raw).game.is_none());
    }

    #[test]
    fn an_unreachable_api_with_league_closed_is_fully_offline() {
        let offline = Snapshot::offline();
        assert_eq!(offline.status.league, LeagueState::NotDetected);
        assert!(offline.game.is_none());
    }

    #[test]
    fn a_running_launcher_without_the_api_still_reports_league_running() {
        let status = api_present_but_unusable();
        assert_eq!(status.league, LeagueState::Running);
        assert_eq!(status.live_api, LiveApiState::Unavailable);
    }
}
