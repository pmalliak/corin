//! Wire types shared with the Worker. These mirror `docs/contracts/*.schema.json`
//! and must not drift from them without a contract version bump.
//!
//! The rule that shapes all of this: everything the Live Client API knows travels,
//! except the identity of other players. Champion, team and position say who did
//! what; summoner names and Riot IDs of the other nine people do not travel and are
//! not stored. The device owner's own Riot ID does, since it is their own data.

use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeagueState {
    #[serde(rename = "Running")]
    Running,
    #[serde(rename = "Not detected")]
    NotDetected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LiveApiState {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CurrentGameState {
    Active,
    Inactive,
}

/// The normalized status the backend stores and `/coach status` renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusPayload {
    pub league: LeagueState,
    #[serde(rename = "liveApi")]
    pub live_api: LiveApiState,
    #[serde(rename = "currentGame")]
    pub current_game: CurrentGameState,
}

impl StatusPayload {
    pub const OFFLINE: Self = Self {
        league: LeagueState::NotDetected,
        live_api: LiveApiState::Unavailable,
        current_game: CurrentGameState::Inactive,
    };
}

impl Default for StatusPayload {
    fn default() -> Self {
        Self::OFFLINE
    }
}

/// What the agent knows right now: the flags, plus the game when one is running.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Snapshot {
    pub status: StatusPayload,
    pub game: Option<GameState>,
}

impl Snapshot {
    pub fn offline() -> Self {
        Self { status: StatusPayload::OFFLINE, game: None }
    }

    pub fn status_only(status: StatusPayload) -> Self {
        Self { status, game: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    /// Identifies the match without identifying anybody in it.
    ///
    /// Riot's local API exposes no game id, but every player in a match sees the
    /// same ten champions on the same two teams, so a hash of that lineup is the
    /// same string on each of their machines and different in any other game.
    /// When two members of the Discord server are in one game, the backend sees
    /// two devices reporting one key, already knows which Discord user owns each,
    /// and each agent has said which champion its own owner is playing. That is
    /// enough to answer "who from here is in your game and on what", with no
    /// summoner name ever leaving a machine.
    pub match_key: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_terrain: Option<String>,
    pub time_seconds: f64,
    pub player: Player,
    pub participants: Vec<Participant>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<GameEvent>,
}

/// Builds the match key from the lineup every player in the game can see.
///
/// Sorted, so two machines listing players in a different order still agree, and
/// team-tagged, so a mirror lineup on swapped sides is a different game.
pub fn match_key(mode: &str, map: Option<&str>, lineup: &mut [(Team, &str)]) -> String {
    use sha2::{Digest, Sha256};

    lineup.sort_unstable_by(|left, right| (left.0 as u8, left.1).cmp(&(right.0 as u8, right.1)));

    let mut hasher = Sha256::new();
    hasher.update(mode.as_bytes());
    hasher.update(b"|");
    hasher.update(map.unwrap_or("").as_bytes());
    for (team, champion) in lineup.iter() {
        hasher.update(b"|");
        hasher.update(match team {
            Team::Order => b"O:".as_slice(),
            Team::Chaos => b"C:".as_slice(),
        });
        hasher.update(champion.as_bytes());
    }
    // Half a SHA-256 is far more than enough to keep concurrent games apart.
    hex(&hasher.finalize()[..16])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The device owner. Carries their own Riot ID, their full champion stats, ability
/// ranks, runes and items: all of it is theirs, and all of it is what coaching needs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub champion: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub riot_id: Option<String>,
    pub team: Team,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    pub level: u8,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub creep_score: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ward_score: Option<f64>,
    pub gold: f64,
    pub is_dead: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respawn_seconds: Option<f64>,
    /// Every stat Riot exposes, passed through untouched. They are all numbers and
    /// they all matter to advice, so naming them one by one would only add drift.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub abilities: Vec<Ability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub summoner_spells: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Item>,
}

/// Everyone else, identified only by champion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub champion: String,
    pub team: Team,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    pub level: u8,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub creep_score: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ward_score: Option<f64>,
    pub is_dead: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub respawn_seconds: Option<f64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_bot: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub summoner_spells: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Item>,
}

/// A match event with every player name already resolved to a champion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEvent {
    pub id: u32,
    pub name: String,
    pub time_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub victim: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub assisters: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dragon_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stolen: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kill_streak: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inhibitor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ability {
    /// Q, W, E, R or Passive.
    pub slot: String,
    pub name: String,
    pub rank: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Team {
    #[serde(rename = "ORDER")]
    Order,
    #[serde(rename = "CHAOS")]
    Chaos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Position {
    Top,
    Jungle,
    Middle,
    Bottom,
    Utility,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u32,
    pub name: String,
    pub slot: u8,
    #[serde(skip_serializing_if = "is_one")]
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub consumable: bool,
}

fn is_one(value: &u32) -> bool {
    *value == 1
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMessageType {
    Hello,
    Heartbeat,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMessage {
    pub version: u8,
    #[serde(rename = "type")]
    pub message_type: SessionMessageType,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub payload: MessagePayload,
}

/// The v1 flags, flattened, with the game alongside them. A v1 reader finds exactly
/// the object it always found and ignores the extra key.
#[derive(Debug, Clone, Serialize)]
pub struct MessagePayload {
    #[serde(flatten)]
    pub status: StatusPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<GameState>,
}

impl SessionMessage {
    pub fn new(message_type: SessionMessageType, snapshot: Snapshot) -> Self {
        Self {
            version: CONTRACT_VERSION,
            message_type,
            request_id: uuid::Uuid::new_v4().to_string(),
            payload: MessagePayload { status: snapshot.status, game: snapshot.game },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingRequest<'a> {
    pub code: &'a str,
    #[serde(rename = "deviceName")]
    pub device_name: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PairingResponse {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub credential: String,
    #[serde(rename = "sessionUrl")]
    pub session_url: String,
    #[serde(default)]
    pub account: Option<PairingAccount>,
}

/// The human-readable side of a pairing. The credential still authorizes only
/// this device; this is simply confirmation that a downloaded agent is joining
/// the Discord account its owner intended.
#[derive(Debug, Clone, Deserialize)]
pub struct PairingAccount {
    pub username: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_game_snapshot() -> Snapshot {
        Snapshot {
            status: StatusPayload {
                league: LeagueState::Running,
                live_api: LiveApiState::Available,
                current_game: CurrentGameState::Active,
            },
            game: Some(GameState {
                match_key: "abc123".into(),
                mode: "CLASSIC".into(),
                map: Some("Map11".into()),
                map_terrain: Some("Default".into()),
                time_seconds: 1142.0,
                player: Player {
                    champion: "Jinx".into(),
                    riot_id: Some("owner#EUNE".into()),
                    team: Team::Order,
                    position: Some(Position::Bottom),
                    level: 11,
                    kills: 4,
                    deaths: 1,
                    assists: 3,
                    creep_score: 142,
                    ward_score: Some(3.4),
                    gold: 2140.0,
                    is_dead: false,
                    respawn_seconds: None,
                    stats: Some(serde_json::json!({ "attackDamage": 120.0, "abilityHaste": 20.0 })),
                    abilities: vec![Ability { slot: "Q".into(), name: "Switcheroo!".into(), rank: 5 }],
                    runes: Some(serde_json::json!({ "keystone": "Lethal Tempo" })),
                    summoner_spells: vec!["Flash".into(), "Heal".into()],
                    items: vec![Item { id: 3866, name: "Runic Compass".into(), slot: 0, count: 1, price: Some(400), consumable: false }],
                },
                participants: vec![Participant {
                    champion: "Ahri".into(),
                    team: Team::Chaos,
                    position: Some(Position::Middle),
                    level: 11,
                    kills: 2,
                    deaths: 3,
                    assists: 4,
                    creep_score: 130,
                    ward_score: None,
                    is_dead: false,
                    respawn_seconds: None,
                    is_bot: false,
                    runes: None,
                    summoner_spells: vec!["Flash".into()],
                    items: vec![],
                }],
                events: vec![GameEvent {
                    id: 12,
                    name: "ChampionKill".into(),
                    time_seconds: 750.0,
                    killer: Some("Ahri".into()),
                    victim: Some("Jinx".into()),
                    assisters: vec!["Lee Sin".into()],
                    recipient: None,
                    dragon_type: None,
                    stolen: None,
                    kill_streak: None,
                    turret: None,
                    inhibitor: None,
                }],
            }),
        }
    }

    #[test]
    fn session_messages_match_the_v2_contract() {
        let message = SessionMessage::new(SessionMessageType::Hello, in_game_snapshot());
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();

        assert_eq!(json["version"], 2);
        assert_eq!(json["type"], "hello");
        assert_eq!(json["payload"]["league"], "Running");
        assert_eq!(json["payload"]["game"]["timeSeconds"], 1142.0);
        assert_eq!(json["payload"]["game"]["player"]["champion"], "Jinx");
        assert_eq!(json["payload"]["game"]["player"]["creepScore"], 142);
        assert_eq!(json["payload"]["game"]["player"]["stats"]["attackDamage"], 120.0);
        assert_eq!(json["payload"]["game"]["participants"][0]["champion"], "Ahri");
        assert_eq!(json["payload"]["game"]["events"][0]["killer"], "Ahri");
        assert!(json["requestId"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(json.as_object().unwrap().len(), 4, "the contract forbids extra properties");
    }

    /// The rule the whole design turns on: nobody else's name travels.
    #[test]
    fn no_other_player_identity_is_ever_serialized() {
        let encoded = serde_json::to_string(&SessionMessage::new(SessionMessageType::Heartbeat, in_game_snapshot())).unwrap();

        for forbidden in ["summonerName", "riotIdGameName", "riotIdTagLine", "killerName", "victimName"] {
            assert!(!encoded.contains(forbidden), "{forbidden} leaked into the message");
        }
        // Events name champions, never people.
        assert!(encoded.contains("\"killer\":\"Ahri\""), "events should name the champion");
    }

    #[test]
    fn the_owner_keeps_their_own_riot_id() {
        let encoded = serde_json::to_string(&in_game_snapshot().game.unwrap().player).unwrap();
        assert!(encoded.contains("owner#EUNE"), "the device owner's own id is their data");
    }

    #[test]
    fn a_status_only_snapshot_omits_the_game_entirely() {
        let message = SessionMessage::new(SessionMessageType::Heartbeat, Snapshot::offline());
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();

        assert_eq!(json["payload"]["league"], "Not detected");
        assert!(json["payload"].get("game").is_none(), "a missing game should be left out, not sent as null");
    }

    /// A v1 reader must still find the three flags where it expects them.
    #[test]
    fn the_v1_flags_stay_at_the_top_of_the_payload() {
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&SessionMessage::new(SessionMessageType::Hello, in_game_snapshot())).unwrap()).unwrap();
        let payload = json["payload"].as_object().unwrap();

        for flag in ["league", "liveApi", "currentGame"] {
            assert!(payload.contains_key(flag), "{flag} moved");
        }
    }

    #[test]
    fn a_not_detected_league_serializes_with_its_space() {
        let json = serde_json::to_string(&StatusPayload::OFFLINE).unwrap();
        assert!(json.contains("\"Not detected\""), "got {json}");
    }

    #[test]
    fn heartbeats_carry_a_fresh_request_id() {
        let first = SessionMessage::new(SessionMessageType::Heartbeat, Snapshot::offline());
        let second = SessionMessage::new(SessionMessageType::Heartbeat, Snapshot::offline());
        assert_ne!(first.request_id, second.request_id);
    }

    fn lineup() -> Vec<(Team, &'static str)> {
        vec![
            (Team::Order, "Jinx"),
            (Team::Order, "Thresh"),
            (Team::Order, "Lee Sin"),
            (Team::Order, "Garen"),
            (Team::Order, "Ahri"),
            (Team::Chaos, "Caitlyn"),
            (Team::Chaos, "Nautilus"),
            (Team::Chaos, "Elise"),
            (Team::Chaos, "Darius"),
            (Team::Chaos, "Zed"),
        ]
    }

    /// The point of the key: two friends in one game must produce the same string
    /// on two different machines, without either of them naming the other.
    #[test]
    fn two_players_in_the_same_game_agree_on_the_match_key() {
        let mut as_one_client_sees_it = lineup();
        let mut as_the_other_sees_it = lineup();
        as_the_other_sees_it.reverse();

        assert_eq!(
            match_key("CLASSIC", Some("Map11"), &mut as_one_client_sees_it),
            match_key("CLASSIC", Some("Map11"), &mut as_the_other_sees_it),
        );
    }

    #[test]
    fn a_different_lineup_is_a_different_match() {
        let mut original = lineup();
        let mut swapped = lineup();
        swapped[0] = (Team::Order, "Vayne");

        assert_ne!(match_key("CLASSIC", Some("Map11"), &mut original), match_key("CLASSIC", Some("Map11"), &mut swapped));
    }

    /// The same ten champions with the sides reversed is not the same game.
    #[test]
    fn swapping_sides_changes_the_match_key() {
        let mut original = lineup();
        let mut mirrored: Vec<(Team, &str)> = lineup()
            .into_iter()
            .map(|(team, champion)| (if team == Team::Order { Team::Chaos } else { Team::Order }, champion))
            .collect();

        assert_ne!(match_key("CLASSIC", Some("Map11"), &mut original), match_key("CLASSIC", Some("Map11"), &mut mirrored));
    }

    #[test]
    fn the_match_key_carries_no_names_and_is_a_fixed_length() {
        let key = match_key("CLASSIC", Some("Map11"), &mut lineup());
        assert_eq!(key.len(), 32);
        assert!(key.chars().all(|character| character.is_ascii_hexdigit()));
    }
}
