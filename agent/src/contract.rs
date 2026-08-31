//! Wire types shared with the Worker. These mirror `docs/contracts/*.schema.json`
//! and must not drift from them without a contract version bump.

use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: u8 = 1;

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
    pub payload: StatusPayload,
}

impl SessionMessage {
    pub fn new(message_type: SessionMessageType, payload: StatusPayload) -> Self {
        Self {
            version: CONTRACT_VERSION,
            message_type,
            request_id: uuid::Uuid::new_v4().to_string(),
            payload,
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
}

#[derive(Debug, Clone, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_messages_match_the_v1_contract() {
        let message = SessionMessage::new(
            SessionMessageType::Hello,
            StatusPayload {
                league: LeagueState::Running,
                live_api: LiveApiState::Available,
                current_game: CurrentGameState::Active,
            },
        );
        let json: serde_json::Value = serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();

        assert_eq!(json["version"], 1);
        assert_eq!(json["type"], "hello");
        assert_eq!(json["payload"]["league"], "Running");
        assert_eq!(json["payload"]["liveApi"], "Available");
        assert_eq!(json["payload"]["currentGame"], "Active");
        assert!(json["requestId"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(json.as_object().unwrap().len(), 4, "the contract forbids extra properties");
    }

    #[test]
    fn a_not_detected_league_serializes_with_its_space() {
        let json = serde_json::to_string(&StatusPayload::OFFLINE).unwrap();
        assert!(json.contains("\"Not detected\""), "got {json}");
    }

    #[test]
    fn heartbeats_carry_a_fresh_request_id() {
        let first = SessionMessage::new(SessionMessageType::Heartbeat, StatusPayload::OFFLINE);
        let second = SessionMessage::new(SessionMessageType::Heartbeat, StatusPayload::OFFLINE);
        assert_ne!(first.request_id, second.request_id);
    }
}
