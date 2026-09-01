//! One-time pairing. Trades a short-lived code from `/coach connect` for a
//! device credential, which is the only secret this machine ever holds.

use anyhow::{anyhow, bail, Context, Result};
use reqwest::StatusCode;

use crate::config::Config;
use crate::contract::{ErrorResponse, PairingRequest, PairingResponse};

pub async fn redeem(client: &reqwest::Client, config: &Config, code: &str) -> Result<PairingResponse> {
    let request = PairingRequest { code, device_name: &config.device_name };
    let response = client
        .post(config.pair_url())
        .json(&request)
        .send()
        .await
        .with_context(|| format!("could not reach {}", config.pair_url()))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    match status {
        StatusCode::OK => serde_json::from_str::<PairingResponse>(&body)
            .with_context(|| format!("the backend returned a pairing response this agent cannot read: {body}")),
        StatusCode::UNAUTHORIZED => match serde_json::from_str::<ErrorResponse>(&body) {
            Ok(error) if error.error == "invalid_pairing_code" => {
                bail!("that pairing code is expired, already used, or mistyped. Run /coach connect again for a fresh one.")
            }
            _ => bail!("the backend rejected the pairing code"),
        },
        StatusCode::BAD_REQUEST => bail!("the backend rejected the pairing request as malformed"),
        other => Err(anyhow!("unexpected response {other} from the pairing endpoint: {body}")),
    }
}

/// The backend hands back an absolute session URL. Trusting it blindly would let a
/// hostile response point the agent's credential somewhere else, so it has to stay
/// on the origin we already chose to talk to.
pub fn session_url_for(config: &Config, response: &PairingResponse) -> Result<String> {
    let configured = reqwest::Url::parse(&config.session_url()).context("the configured base URL is not a URL")?;
    let returned = reqwest::Url::parse(&response.session_url).context("the backend returned a session URL that is not a URL")?;

    if returned.origin() != configured.origin() {
        bail!(
            "the backend pointed the session at another origin ({}), refusing to send the credential there",
            returned.origin().ascii_serialization()
        );
    }
    Ok(returned.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            base_url: "https://corin.example".to_owned(),
            device_name: "Test PC".to_owned(),
            use_keyring: false,
        }
    }

    fn response(session_url: &str) -> PairingResponse {
        PairingResponse {
            device_id: "device-1".to_owned(),
            credential: "a".repeat(64),
            session_url: session_url.to_owned(),
            account: None,
        }
    }

    #[test]
    fn a_same_origin_session_url_is_accepted() {
        let url = session_url_for(&config(), &response("https://corin.example/agent/session")).unwrap();
        assert_eq!(url, "https://corin.example/agent/session");
    }

    #[test]
    fn a_redirected_session_url_is_refused() {
        let error = session_url_for(&config(), &response("https://attacker.example/agent/session")).unwrap_err();
        assert!(error.to_string().contains("another origin"), "got {error}");
    }

    #[test]
    fn a_downgraded_session_url_is_refused() {
        let error = session_url_for(&config(), &response("http://corin.example/agent/session")).unwrap_err();
        assert!(error.to_string().contains("another origin"), "got {error}");
    }
}
