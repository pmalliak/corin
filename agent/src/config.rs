//! Runtime configuration. Everything has a working default so a friend can run
//! the binary with no arguments and no config file.

use std::time::Duration;

use anyhow::{bail, Result};

pub const DEFAULT_BASE_URL: &str = "https://corin.panos-malliakoudis.workers.dev";

/// Live snapshots are sent every two seconds. This keeps the coach within a
/// couple of seconds of the local League client while still leaving ample room
/// below the backend's 75-second disconnect threshold for a brief outage.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);

pub const FIRST_RECONNECT_DELAY: Duration = Duration::from_secs(2);
pub const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct Config {
    pub base_url: String,
    pub device_name: String,
    pub use_keyring: bool,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            base_url: std::env::var("CORIN_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_owned()),
            device_name: std::env::var("CORIN_DEVICE_NAME").unwrap_or_else(|_| default_device_name()),
            use_keyring: std::env::var("CORIN_NO_KEYRING").is_err(),
        }
    }

    pub fn pair_url(&self) -> String {
        format!("{}/agent/pair", self.base_url.trim_end_matches('/'))
    }

    pub fn session_url(&self) -> String {
        format!("{}/agent/session", self.base_url.trim_end_matches('/'))
    }
}

fn default_device_name() -> String {
    let hostname = gethostname::gethostname().to_string_lossy().trim().to_owned();
    let name = if hostname.is_empty() { "Unnamed PC".to_owned() } else { hostname };
    name.chars().take(80).collect()
}

/// Pairing codes are twelve alphanumeric characters. The backend hashes the
/// uppercase form, and normalizing here keeps a lowercase paste from failing
/// with a misleading "invalid code".
pub fn normalize_pairing_code(input: &str) -> Result<String> {
    let code: String = input.chars().filter(|character| !character.is_whitespace() && *character != '-').collect();
    if code.len() != 12 || !code.chars().all(|character| character.is_ascii_alphanumeric()) {
        bail!("a pairing code is 12 letters and digits, got {:?}", input.trim());
    }
    Ok(code.to_ascii_uppercase())
}

/// Full jitter backoff, so a backend restart does not bring every agent back at once.
pub fn next_reconnect_delay(previous: Duration) -> Duration {
    let doubled = previous.saturating_mul(2).min(MAX_RECONNECT_DELAY);
    let jitter = fastrand_fraction();
    let millis = (doubled.as_millis() as f64 * (0.5 + 0.5 * jitter)) as u64;
    Duration::from_millis(millis.max(FIRST_RECONNECT_DELAY.as_millis() as u64 / 2))
}

/// A tiny source of randomness so the agent does not pull in a crate for one number.
fn fastrand_fraction() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.subsec_nanos()).unwrap_or(0);
    f64::from(nanos % 1_000) / 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_are_uppercased_and_stripped() {
        assert_eq!(normalize_pairing_code("9c5510bd61ec").unwrap(), "9C5510BD61EC");
        assert_eq!(normalize_pairing_code("  9C5510BD61EC \n").unwrap(), "9C5510BD61EC");
        assert_eq!(normalize_pairing_code("9C55-10BD-61EC").unwrap(), "9C5510BD61EC");
    }

    #[test]
    fn a_malformed_pairing_code_is_rejected_before_the_network() {
        assert!(normalize_pairing_code("").is_err());
        assert!(normalize_pairing_code("TOO-SHORT").is_err());
        assert!(normalize_pairing_code("9C5510BD61ECEXTRA").is_err());
        assert!(normalize_pairing_code("9C5510BD61E!").is_err());
    }

    #[test]
    fn urls_survive_a_trailing_slash() {
        let config = Config {
            base_url: "https://example.com/".to_owned(),
            device_name: "PC".to_owned(),
            use_keyring: false,
        };
        assert_eq!(config.pair_url(), "https://example.com/agent/pair");
        assert_eq!(config.session_url(), "https://example.com/agent/session");
    }

    #[test]
    fn backoff_grows_but_stays_bounded() {
        let mut delay = FIRST_RECONNECT_DELAY;
        for _ in 0..20 {
            delay = next_reconnect_delay(delay);
            assert!(delay <= MAX_RECONNECT_DELAY, "delay ran away to {delay:?}");
        }
        assert!(delay >= Duration::from_secs(20), "backoff should reach a slow poll, got {delay:?}");
    }

    #[test]
    fn a_device_name_is_never_empty_and_never_too_long() {
        let name = default_device_name();
        assert!(!name.is_empty());
        assert!(name.chars().count() <= 80);
    }
}
