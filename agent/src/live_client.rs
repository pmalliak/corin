//! Reads League's Live Client API on this machine.
//!
//! That API only exists while a game is actually running, so its absence says
//! nothing on its own: League might be closed, or sitting in champion select.
//! The process list settles which, and the two together give the three states
//! `/coach status` reports.
//!
//! Nothing here leaves the machine except the three normalized flags. The raw
//! payload is large and full of player identity, and it is never forwarded.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;

use crate::contract::{CurrentGameState, LeagueState, LiveApiState, StatusPayload};
use crate::provider::GameDataProvider;

const ALL_GAME_DATA: &str = "https://127.0.0.1:2999/liveclientdata/allgamedata";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Names as they appear in Task Manager. The first is the game itself, the rest
/// are the launcher, which counts as League being open but not in a game.
const LEAGUE_PROCESSES: [&str; 3] = ["League of Legends.exe", "LeagueClient.exe", "LeagueClientUx.exe"];

/// Polls in the background and keeps the latest answer ready, so a heartbeat
/// never waits on a request and a slow local API cannot stall the session.
pub struct LiveClientProvider {
    latest: Arc<Mutex<StatusPayload>>,
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
                if *slot != next {
                    tracing::info!(?next, "league status changed");
                }
                *slot = next;
            }
        });

        Ok(Self { latest })
    }
}

impl GameDataProvider for LiveClientProvider {
    fn status(&self) -> StatusPayload {
        *self.latest.lock().expect("live status lock poisoned")
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

async fn probe(client: &reqwest::Client) -> StatusPayload {
    match client.get(ALL_GAME_DATA).send().await {
        Ok(response) if response.status().is_success() => match response.json::<LiveGameData>().await {
            Ok(data) => StatusPayload {
                league: LeagueState::Running,
                live_api: LiveApiState::Available,
                // Zero means the game is still loading, which is not yet playable.
                current_game: if data.game_data.game_time > 0.0 { CurrentGameState::Active } else { CurrentGameState::Inactive },
            },
            Err(error) => {
                tracing::warn!(%error, "live client answered with something unreadable");
                api_present_but_unusable()
            }
        },
        // The port answered but not with data, so the game is there and not ready.
        Ok(response) => {
            tracing::debug!(status = %response.status(), "live client not ready");
            api_present_but_unusable()
        }
        Err(_) if league_is_running() => StatusPayload {
            league: LeagueState::Running,
            live_api: LiveApiState::Unavailable,
            current_game: CurrentGameState::Inactive,
        },
        Err(_) => StatusPayload::OFFLINE,
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

/// Only the fields the status flags need. The real payload carries player
/// identity, items, runes and a full event log, none of which belongs here yet.
#[derive(Debug, Deserialize)]
struct LiveGameData {
    #[serde(rename = "gameData")]
    game_data: GameData,
}

#[derive(Debug, Deserialize)]
struct GameData {
    #[serde(rename = "gameTime")]
    game_time: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loaded_game_reads_as_active() {
        let data: LiveGameData = serde_json::from_str(r#"{"gameData":{"gameMode":"CLASSIC","gameTime":2070.5,"mapName":"Map11"}}"#).unwrap();
        assert!(data.game_data.game_time > 0.0);
    }

    #[test]
    fn a_loading_screen_reads_as_inactive() {
        let data: LiveGameData = serde_json::from_str(r#"{"gameData":{"gameMode":"CLASSIC","gameTime":0.0,"mapName":"Map11"}}"#).unwrap();
        assert_eq!(data.game_data.game_time, 0.0);
    }

    #[test]
    fn the_rest_of_the_payload_is_ignored_rather_than_rejected() {
        let payload = r#"{
            "activePlayer": {"summonerName":"someone","riotId":"someone#EUNE","level":3},
            "allPlayers": [{"championName":"Jinx","scores":{"kills":4}}],
            "events": {"Events":[{"EventID":0,"EventName":"GameStart"}]},
            "gameData": {"gameMode":"PRACTICETOOL","gameTime":12.0,"mapName":"Map11"}
        }"#;
        let data: LiveGameData = serde_json::from_str(payload).unwrap();
        assert_eq!(data.game_data.game_time, 12.0);
    }

    #[test]
    fn an_unreachable_api_with_league_closed_is_fully_offline() {
        let offline = StatusPayload::OFFLINE;
        assert_eq!(offline.league, LeagueState::NotDetected);
        assert_eq!(offline.live_api, LiveApiState::Unavailable);
        assert_eq!(offline.current_game, CurrentGameState::Inactive);
    }

    #[test]
    fn a_running_launcher_without_the_api_still_reports_league_running() {
        let status = api_present_but_unusable();
        assert_eq!(status.league, LeagueState::Running);
        assert_eq!(status.live_api, LiveApiState::Unavailable);
    }
}
