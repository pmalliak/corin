//! Where game status comes from. The real Live Client API provider lands behind
//! this same trait, so the session loop never learns which one it is talking to.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::contract::{CurrentGameState, LeagueState, LiveApiState, StatusPayload};

pub trait GameDataProvider: Send + Sync {
    /// The current normalized status. Called once per heartbeat, so it must not block.
    fn status(&self) -> StatusPayload;

    fn name(&self) -> &'static str;
}

/// Walks a scripted sequence so the whole pairing and status path can be exercised
/// without League installed. Each call advances one step and then holds on the last.
pub struct FixtureProvider {
    script: Vec<StatusPayload>,
    step: AtomicUsize,
}

impl FixtureProvider {
    pub fn new(script: Vec<StatusPayload>) -> Self {
        assert!(!script.is_empty(), "a fixture needs at least one step");
        Self { script, step: AtomicUsize::new(0) }
    }

    /// Cold start to in game, one step per heartbeat.
    pub fn startup_sequence() -> Self {
        Self::new(vec![
            StatusPayload::OFFLINE,
            StatusPayload {
                league: LeagueState::Running,
                live_api: LiveApiState::Unavailable,
                current_game: CurrentGameState::Inactive,
            },
            StatusPayload {
                league: LeagueState::Running,
                live_api: LiveApiState::Available,
                current_game: CurrentGameState::Inactive,
            },
            StatusPayload {
                league: LeagueState::Running,
                live_api: LiveApiState::Available,
                current_game: CurrentGameState::Active,
            },
        ])
    }

    /// Every call reports the same thing. Useful when you want a predictable
    /// `/coach status` while testing something else.
    pub fn fixed(status: StatusPayload) -> Self {
        Self::new(vec![status])
    }

    /// `CORIN_FIXTURE=active` pins the agent to "in a game" so `/coach status` can
    /// be checked in one shot, `offline` pins it to nothing running, and anything
    /// else walks the startup sequence.
    pub fn from_env() -> Self {
        match std::env::var("CORIN_FIXTURE").unwrap_or_default().to_ascii_lowercase().as_str() {
            "active" => Self::fixed(IN_GAME),
            "offline" => Self::fixed(StatusPayload::OFFLINE),
            _ => Self::startup_sequence(),
        }
    }
}

pub const IN_GAME: StatusPayload = StatusPayload {
    league: LeagueState::Running,
    live_api: LiveApiState::Available,
    current_game: CurrentGameState::Active,
};

impl GameDataProvider for FixtureProvider {
    fn status(&self) -> StatusPayload {
        let step = self.step.fetch_add(1, Ordering::Relaxed);
        self.script[step.min(self.script.len() - 1)]
    }

    fn name(&self) -> &'static str {
        "fixture"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_startup_sequence_walks_from_offline_to_in_game() {
        let provider = FixtureProvider::startup_sequence();

        assert_eq!(provider.status(), StatusPayload::OFFLINE);
        assert_eq!(provider.status().league, LeagueState::Running);
        assert_eq!(provider.status().live_api, LiveApiState::Available);
        assert_eq!(provider.status().current_game, CurrentGameState::Active);
    }

    #[test]
    fn the_last_step_holds_once_the_script_runs_out() {
        let provider = FixtureProvider::startup_sequence();
        for _ in 0..10 {
            provider.status();
        }

        let settled = provider.status();
        assert_eq!(settled.league, LeagueState::Running);
        assert_eq!(settled.current_game, CurrentGameState::Active);
    }

    #[test]
    fn a_fixed_fixture_never_moves() {
        let provider = FixtureProvider::fixed(StatusPayload::OFFLINE);
        assert_eq!(provider.status(), StatusPayload::OFFLINE);
        assert_eq!(provider.status(), StatusPayload::OFFLINE);
    }
}
