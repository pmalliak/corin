//! The outbound session. Opens one WebSocket to the backend, says hello, and
//! heartbeats until something breaks. Nothing here ever listens on a port.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::config::{next_reconnect_delay, Config, FIRST_RECONNECT_DELAY, HEARTBEAT_INTERVAL};
use crate::contract::{SessionMessage, SessionMessageType};
use crate::provider::GameDataProvider;

#[derive(Debug)]
pub enum SessionEnd {
    /// The socket dropped. Worth retrying with the same credential.
    Dropped(anyhow::Error),
    /// The backend refused the credential. The device was revoked or removed,
    /// so retrying cannot help and the user has to pair again.
    CredentialRejected,
    /// Ctrl+C or a close from the backend that we chose to honour.
    Stopped,
}

/// Turns an https base URL into the wss URL tungstenite needs.
pub fn websocket_url(session_url: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(session_url).context("the session URL is not a URL")?;
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        other => return Err(anyhow!("unsupported session URL scheme {other}")),
    };
    url.set_scheme(scheme).map_err(|()| anyhow!("could not set the session URL scheme"))?;
    Ok(url.to_string())
}

/// A session that lasted this long counts as healthy, so the next failure starts
/// backing off from the beginning instead of from wherever the last outage ended.
const HEALTHY_SESSION: Duration = Duration::from_secs(60);

/// Reconnects with backoff until the credential is rejected or the user stops it.
pub async fn run_forever(config: &Config, session_url: &str, credential: &str, provider: Arc<dyn GameDataProvider>) -> SessionEnd {
    let mut delay = FIRST_RECONNECT_DELAY;

    loop {
        let started = tokio::time::Instant::now();
        let outcome = run_once(session_url, credential, Arc::clone(&provider)).await;

        match outcome {
            SessionEnd::CredentialRejected => return SessionEnd::CredentialRejected,
            SessionEnd::Stopped => return SessionEnd::Stopped,
            SessionEnd::Dropped(error) => {
                if started.elapsed() >= HEALTHY_SESSION {
                    delay = FIRST_RECONNECT_DELAY;
                }
                delay = next_reconnect_delay(delay);
                tracing::warn!(%error, backend = %config.base_url, retry_in = ?delay, "session dropped");

                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    _ = tokio::signal::ctrl_c() => return SessionEnd::Stopped,
                }
            }
        }
    }
}

async fn run_once(session_url: &str, credential: &str, provider: Arc<dyn GameDataProvider>) -> SessionEnd {
    let socket = match connect(session_url, credential).await {
        Ok(socket) => socket,
        Err(ConnectError::Unauthorized) => return SessionEnd::CredentialRejected,
        Err(ConnectError::Other(error)) => return SessionEnd::Dropped(error),
    };

    tracing::info!(provider = provider.name(), "session open");

    // Reading and writing have to be separable: a select! that both sends on a tick
    // and awaits the next frame would hold two mutable borrows of one socket.
    let (mut writer, mut reader) = socket.split();

    if let Err(error) = send(&mut writer, SessionMessageType::Hello, provider.as_ref()).await {
        return SessionEnd::Dropped(error);
    }

    let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // the first tick completes immediately, and hello already covered it

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if let Err(error) = send(&mut writer, SessionMessageType::Heartbeat, provider.as_ref()).await {
                    return SessionEnd::Dropped(error);
                }
            }
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => tracing::debug!(%text, "backend acknowledged"),
                    Some(Ok(Message::Close(frame))) => {
                        tracing::warn!(?frame, "backend closed the session");
                        return SessionEnd::Dropped(anyhow!("backend closed the session"));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return SessionEnd::Dropped(anyhow!(error).context("session read failed")),
                    None => return SessionEnd::Dropped(anyhow!("session ended without a close frame")),
                }
            }
            _ = tokio::signal::ctrl_c() => {
                let _ = writer.close().await;
                return SessionEnd::Stopped;
            }
        }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Writer = futures_util::stream::SplitSink<Socket, Message>;

enum ConnectError {
    Unauthorized,
    Other(anyhow::Error),
}

async fn connect(session_url: &str, credential: &str) -> Result<Socket, ConnectError> {
    let url = websocket_url(session_url).map_err(ConnectError::Other)?;
    let mut request = url.into_client_request().map_err(|error| ConnectError::Other(anyhow!(error)))?;
    let authorization = format!("Bearer {credential}")
        .parse()
        .map_err(|_| ConnectError::Other(anyhow!("the stored credential is not a valid header value")))?;
    request.headers_mut().insert("authorization", authorization);

    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _response)) => Ok(socket),
        Err(WsError::Http(response)) if response.status() == 401 => Err(ConnectError::Unauthorized),
        Err(error) => Err(ConnectError::Other(anyhow!(error).context("could not open the session"))),
    }
}

async fn send(writer: &mut Writer, message_type: SessionMessageType, provider: &dyn GameDataProvider) -> Result<()> {
    let message = SessionMessage::new(message_type, provider.status());
    let encoded = serde_json::to_string(&message).context("could not encode a session message")?;
    writer.send(Message::Text(encoded)).await.context("could not send a session message")?;
    tracing::debug!(?message_type, "sent");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How long the backend keeps trusting a heartbeat. Asserted against rather
    /// than used, so that shortening one side without the other fails a test.
    const BACKEND_STATUS_TTL: Duration = Duration::from_secs(75);

    #[test]
    fn https_session_urls_become_wss() {
        assert_eq!(websocket_url("https://corin.example/agent/session").unwrap(), "wss://corin.example/agent/session");
    }

    #[test]
    fn local_http_session_urls_become_ws() {
        assert_eq!(websocket_url("http://127.0.0.1:8787/agent/session").unwrap(), "ws://127.0.0.1:8787/agent/session");
    }

    #[test]
    fn an_unsupported_scheme_is_refused() {
        assert!(websocket_url("ftp://corin.example/agent/session").is_err());
    }

    #[test]
    fn heartbeats_fit_inside_the_backend_ttl_with_room_to_spare() {
        assert!(
            HEARTBEAT_INTERVAL * 3 < BACKEND_STATUS_TTL,
            "two lost heartbeats must not be enough to look disconnected",
        );
    }
}
