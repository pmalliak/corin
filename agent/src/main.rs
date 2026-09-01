//! Corin agent. Pairs this machine to a Discord account once, then keeps an
//! outbound session open so `/coach status` can report real League state.
//!
//! Built for the windows subsystem, so nothing reaches the screen unless the agent
//! puts it there: the tray icon for as long as it runs, and a console only for
//! somebody who typed a command or is waiting to paste a pairing code. The
//! `console` module is where that is arranged.
#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

mod autostart;
mod config;
mod console;
mod contract;
mod credential;
mod live_client;
mod pairing;
mod provider;
mod session;
#[cfg(windows)]
mod tray;

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
    // The Run key passes --background. It is a mode rather than a command: nobody
    // is watching a login, so nothing there may open a window or ask a question.
    let background = std::env::args().any(|argument| argument == autostart::BACKGROUND_FLAG);

    // Before the first print. With no console of any kind, every println! in this
    // process quietly writes into nothing.
    if !background {
        console::attach_to_terminal();
    }

    // rustls 0.23 refuses to pick a backend on its own once more than one could apply.
    let _ = rustls::crypto::ring::default_provider().install_default();
    init_tracing();

    if let Err(error) = run(background).await {
        if !background {
            console::open();
        }
        eprintln!("\nCorin agent stopped: {error:#}");
        if console::is_ours() {
            wait_for_enter();
        }
        std::process::exit(1);
    }
}

async fn run(background: bool) -> Result<()> {
    let config = Config::from_env();
    let store: Box<dyn CredentialStore> = if config.use_keyring { Box::new(KeyringStore::new()) } else { Box::new(MemoryStore::new()) };
    let client = reqwest::Client::builder()
        .user_agent(concat!("corin-agent/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .context("could not build the HTTP client")?;

    // --background was read in main, so it is dropped here before anything tries to
    // read it as a command.
    let arguments = std::env::args().skip(1).filter(|argument| argument != autostart::BACKGROUND_FLAG);

    match Command::parse(arguments)? {
        Command::Autostart(action) => run_autostart(action),
        Command::Reset => {
            store.clear()?;
            autostart::disable()?;
            println!("Device credential removed, and this machine no longer starts the agent on login.");
            println!("Run /coach connect in Discord to pair again.");
            Ok(())
        }
        Command::Status => {
            match store.load()? {
                Some(_) => println!("Paired. Backend: {}", config.base_url),
                None => println!("Not paired. Run /coach connect in Discord, then run this agent with the code."),
            }
            println!("Starts with Windows: {}", if autostart::is_enabled() { "yes" } else { "no" });
            Ok(())
        }
        Command::Pair(code) => {
            pair(&client, &config, store.as_ref(), &code).await?;
            console::hide();
            serve(&config, store.as_ref()).await
        }
        Command::Run => {
            if store.load()?.is_none() {
                // The code has to be typed somewhere, and a double-click starts with
                // nowhere to type it. A login has nobody to ask in the first place.
                anyhow::ensure!(
                    !background,
                    "this machine is not paired yet. Start the agent from your desktop and paste a code from /coach connect."
                );
                console::open();
                let code = prompt_for_pairing_code()?;
                pair(&client, &config, store.as_ref(), &code).await?;
            }
            // Paired, so the console has done its job and Corin lives in the tray.
            console::hide();
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
    match response.account {
        Some(account) => println!(
            "Paired as \"{}\" for Discord account {}. This machine will reconnect on its own from now on.",
            config.device_name, account.username
        ),
        None => println!("Paired as \"{}\". This machine will reconnect on its own from now on.", config.device_name),
    }
    tracing::info!(device_id = %response.device_id, "paired");
    offer_autostart();
    Ok(())
}

/// Asked once, right after pairing, because a coach that only runs when you
/// remember to start it is a coach you stop using. Declining is one keystroke and
/// `corin-agent autostart on` is always there later.
fn offer_autostart() {
    if !std::io::stdin().is_terminal() || autostart::is_enabled() {
        return;
    }

    print!("Start Corin automatically when Windows starts? [Y/n] ");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    if std::io::stdin().read_line(&mut answer).is_err() {
        return;
    }

    if matches!(answer.trim().to_ascii_lowercase().as_str(), "" | "y" | "yes") {
        match autostart::enable() {
            Ok(_) => println!("Done. Corin will be running next time you log in."),
            Err(error) => eprintln!("Could not set that up: {error:#}"),
        }
    } else {
        println!("Fine. Run `corin-agent autostart on` whenever you change your mind.");
    }
}

fn run_autostart(action: AutostartAction) -> Result<()> {
    match action {
        AutostartAction::On => {
            let command = autostart::enable()?;
            println!("Corin will start with Windows:\n  {command}");
        }
        AutostartAction::Off => {
            autostart::disable()?;
            println!("Corin will no longer start with Windows.");
        }
        AutostartAction::Show => match autostart::current()? {
            Some(command) => println!("Starts with Windows:\n  {command}"),
            None => println!("Does not start with Windows. Run `corin-agent autostart on` to change that."),
        },
    }
    Ok(())
}

async fn serve(config: &Config, store: &dyn CredentialStore) -> Result<()> {
    let credential = store.load()?.context("no device credential is stored")?;
    let provider = game_data_provider().await?;

    // A double-clicked agent should feel like a small desktop app, not a terminal
    // that has accidentally been left open. The tray owns its Win32 message loop
    // on another thread; Tokio can therefore keep doing network work here.
    #[cfg(windows)]
    tray::start()?;

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
    Autostart(AutostartAction),
}

enum AutostartAction {
    On,
    Off,
    Show,
}

impl Command {
    fn parse(mut args: impl Iterator<Item = String>) -> Result<Self> {
        let Some(first) = args.next() else {
            return Ok(Self::Run);
        };

        match first.as_str() {
            "reset" | "--reset" => Ok(Self::Reset),
            "status" | "--status" => Ok(Self::Status),
            "autostart" | "--autostart" => match args.next().as_deref() {
                None | Some("show") | Some("status") => Ok(Self::Autostart(AutostartAction::Show)),
                Some("on") | Some("enable") => Ok(Self::Autostart(AutostartAction::On)),
                Some("off") | Some("disable") => Ok(Self::Autostart(AutostartAction::Off)),
                Some(other) => anyhow::bail!("autostart takes on, off, or show, not {other:?}"),
            },
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
  corin-agent autostart on    start with Windows from now on
  corin-agent autostart off   stop doing that
  corin-agent reset           forget the credential and the startup entry
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

/// Only ever for a console the agent opened itself, which closes with the process
/// and would take the message with it. A terminal keeps its own scrollback.
fn wait_for_enter() {
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
