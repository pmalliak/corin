//! Corin agent. Pairs this machine to a Discord account once, then keeps an
//! outbound session open so `/coach status` can report real League state.

mod config;
mod contract;
mod credential;
mod live_client;
mod pairing;
mod provider;
mod session;

use std::io::{IsTerminal, Write};
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::config::Config;
use crate::credential::{CredentialStore, KeyringStore, MemoryStore};
use crate::live_client::LiveClientProvider;
use crate::provider::{FixtureProvider, GameDataProvider};
use crate::session::SessionEnd;

#[tokio::main]
async fn main() {
    // rustls 0.23 refuses to pick a backend on its own once more than one could apply.
    let _ = rustls::crypto::ring::default_provider().install_default();
    init_tracing();

    if let Err(error) = run().await {
        eprintln!("\nCorin agent stopped: {error:#}");
        wait_for_enter_if_launched_by_double_click();
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let config = Config::from_env();
    let store: Box<dyn CredentialStore> = if config.use_keyring { Box::new(KeyringStore::new()) } else { Box::new(MemoryStore::new()) };
    let client = reqwest::Client::builder()
        .user_agent(concat!("corin-agent/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("could not build the HTTP client")?;

    match Command::parse(std::env::args().skip(1))? {
        Command::Reset => {
            store.clear()?;
            println!("Device credential removed. Run /coach connect in Discord to pair again.");
            Ok(())
        }
        Command::Status => {
            match store.load()? {
                Some(_) => println!("Paired. Backend: {}", config.base_url),
                None => println!("Not paired. Run /coach connect in Discord, then run this agent with the code."),
            }
            Ok(())
        }
        Command::Pair(code) => {
            pair(&client, &config, store.as_ref(), &code).await?;
            serve(&config, store.as_ref()).await
        }
        Command::Run => {
            if store.load()?.is_none() {
                let code = prompt_for_pairing_code()?;
                pair(&client, &config, store.as_ref(), &code).await?;
            }
            serve(&config, store.as_ref()).await
        }
    }
}

async fn pair(client: &reqwest::Client, config: &Config, store: &dyn CredentialStore, code: &str) -> Result<()> {
    let response = pairing::redeem(client, config, code).await?;
    // Checked even though we build our own session URL, because a mismatch means
    // the backend is not the one we think we are talking to.
    pairing::session_url_for(config, &response)?;
    store.save(&response.credential)?;
    println!("Paired as \"{}\". This machine will reconnect on its own from now on.", config.device_name);
    tracing::info!(device_id = %response.device_id, "paired");
    Ok(())
}

async fn serve(config: &Config, store: &dyn CredentialStore) -> Result<()> {
    let credential = store.load()?.context("no device credential is stored")?;
    let provider = game_data_provider().await?;

    println!("Reporting status to {}. Press Ctrl+C to stop.", config.base_url);

    match session::run_forever(config, &config.session_url(), &credential, provider).await {
        SessionEnd::Stopped => {
            println!("Stopped.");
            Ok(())
        }
        SessionEnd::CredentialRejected => {
            store.clear()?;
            anyhow::bail!("this device is no longer authorized. Run /coach connect in Discord and pair again.")
        }
        SessionEnd::Dropped(error) => Err(error),
    }
}

/// Real League data unless CORIN_FIXTURE asks for a scripted one, so a friend who
/// just double clicks the binary gets the real thing without knowing it had a choice.
async fn game_data_provider() -> Result<Arc<dyn GameDataProvider>> {
    if std::env::var("CORIN_FIXTURE").is_ok() {
        println!("Using a scripted fixture, not League.");
        return Ok(Arc::new(FixtureProvider::from_env()));
    }
    Ok(Arc::new(LiveClientProvider::start().await?))
}

enum Command {
    Run,
    Pair(String),
    Reset,
    Status,
}

impl Command {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self> {
        let Some(first) = args.next() else {
            return Ok(Self::Run);
        };

        match first.as_str() {
            "reset" | "--reset" => Ok(Self::Reset),
            "status" | "--status" => Ok(Self::Status),
            "pair" | "--pair" => {
                let code = args.next().context("pair needs a code, for example: corin-agent pair 9C5510BD61EC")?;
                Ok(Self::Pair(config::normalize_pairing_code(&code)?))
            }
            "help" | "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            maybe_code => Ok(Self::Pair(config::normalize_pairing_code(maybe_code)?)),
        }
    }
}

fn print_usage() {
    println!(
        "\
Corin agent

  corin-agent                 pair if needed, then report status
  corin-agent <CODE>          pair with a code from /coach connect
  corin-agent pair <CODE>     the same thing, spelled out
  corin-agent status          say whether this machine is paired
  corin-agent reset           forget the device credential
  corin-agent help            this text

Environment:
  CORIN_BASE_URL              backend to talk to (default {default})
  CORIN_DEVICE_NAME           how this machine appears in Discord
  CORIN_FIXTURE               active, offline, or a startup sequence (default)
  CORIN_NO_KEYRING            do not touch the OS keystore, forget on exit
  RUST_LOG                    log filter, for example corin_agent=debug",
        default = config::DEFAULT_BASE_URL,
    );
}

fn prompt_for_pairing_code() -> Result<String> {
    if !std::io::stdin().is_terminal() {
        anyhow::bail!("no device credential is stored. Run: corin-agent pair <CODE>");
    }

    println!("This machine is not paired yet.");
    println!("Run /coach connect in Discord, then paste the code here.\n");

    for attempt in 1..=3 {
        print!("Pairing code: ");
        std::io::stdout().flush().ok();

        let mut line = String::new();
        std::io::stdin().read_line(&mut line).context("could not read the pairing code")?;

        match config::normalize_pairing_code(&line) {
            Ok(code) => return Ok(code),
            Err(error) if attempt < 3 => eprintln!("{error}\n"),
            Err(error) => return Err(error),
        }
    }
    unreachable!("the loop returns on the third attempt")
}

fn wait_for_enter_if_launched_by_double_click() {
    if !std::io::stdin().is_terminal() {
        return;
    }
    eprint!("Press Enter to close.");
    let _ = std::io::stdout().flush();
    let mut discard = String::new();
    let _ = std::io::stdin().read_line(&mut discard);
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("corin_agent=info,warn"));
    fmt().with_env_filter(filter).with_target(false).without_time().init();
}
