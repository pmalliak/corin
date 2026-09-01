//! The small Windows surface for the otherwise headless agent.
//!
//! `tray-icon` needs a Win32 message loop on the same thread that creates the
//! icon. Tokio owns the main thread, so this module gives the tray its own tiny
//! UI thread and leaves the agent's networking runtime alone.

use std::sync::mpsc;
use std::thread;

use anyhow::{Context, Result};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    Icon, TrayIconBuilder,
};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, TranslateMessage, MSG};

const QUIT_ID: &str = "quit";

/// Starts the notification-area icon and waits until Windows has accepted it.
///
/// There is deliberately no separate "disconnect" action: stopping the local
/// agent would make the voice coach stale and look like a bug. The one explicit
/// exit is still important, especially while diagnosing a pairing.
pub fn start() -> Result<()> {
    let (ready, result) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("corin-tray".into())
        .spawn(move || run(ready))
        .context("could not start the Corin tray")?;

    result
        .recv()
        .context("the Corin tray stopped before it was ready")?
        .map_err(anyhow::Error::msg)
}

fn run(ready: mpsc::SyncSender<std::result::Result<(), String>>) {
    let status = MenuItem::with_id("status", "Corin is running", false, None);
    let separator = PredefinedMenuItem::separator();
    let quit = MenuItem::with_id(QUIT_ID, "Quit Corin", true, None);
    let menu = match Menu::with_items(&[&status, &separator, &quit]) {
        Ok(menu) => menu,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };

    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        if event.id.as_ref() == QUIT_ID {
            // The connection is outbound and carries no local state, so process
            // exit is a safe, immediate stop even when the backend is offline.
            std::process::exit(0);
        }
    }));

    let tray = match TrayIconBuilder::new()
        .with_tooltip("Corin is running — right-click for options")
        .with_menu(Box::new(menu))
        .with_icon(corin_icon())
        .build()
    {
        Ok(tray) => tray,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };

    // Keep the reference alive for as long as the message loop does. Dropping
    // it removes the icon from Explorer immediately.
    let _tray = tray;
    let _ = ready.send(Ok(()));

    unsafe {
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

/// A compact, high-contrast Corin mark for the 16–32px notification area.
/// The executable itself uses the bundled multi-size `.ico`; this RGBA version
/// avoids a runtime ICO decoder or sidecar file.
fn corin_icon() -> Icon {
    const SIZE: u32 = 32;
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance > 14.5 {
                continue;
            }

            let index = ((y * SIZE + x) * 4) as usize;
            let glow = ((14.5 - distance) / 14.5 * 28.0) as u8;
            rgba[index..index + 4].copy_from_slice(&[83 + glow, 45 + glow / 2, 166 + glow, 255]);

            // A simple white rune remains legible when Windows scales it down.
            if (dx.abs() < 1.5 && dy.abs() < 9.0) || (dy.abs() < 1.5 && dx.abs() < 9.0) {
                rgba[index..index + 4].copy_from_slice(&[244, 241, 255, 255]);
            }
        }
    }

    Icon::from_rgba(rgba, SIZE, SIZE).expect("the generated Corin tray icon has valid dimensions")
}
