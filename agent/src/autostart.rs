//! Starting with Windows.
//!
//! A per-user Run key, so no administrator rights and nothing to uninstall: the
//! entry points at wherever the binary already sits, and removing it is one
//! registry value. The entry passes `--background`, which the agent uses to let
//! go of the console window it would otherwise leave open on every login.


/// The argument the Run entry passes, and the flag that means "no console".
pub const BACKGROUND_FLAG: &str = "--background";

#[cfg(windows)]
mod platform {
    use super::BACKGROUND_FLAG;
    use anyhow::{Context, Result};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "Corin Agent";

    /// Quoted, because the binary usually lives under a path with spaces.
    fn command_line() -> Result<String> {
        let executable = std::env::current_exe().context("could not find this executable's own path")?;
        Ok(format!("\"{}\" {BACKGROUND_FLAG}", executable.display()))
    }

    pub fn enable() -> Result<String> {
        let command = command_line()?;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(RUN_KEY)
            .context("could not open the per-user startup key")?;
        key.set_value(VALUE_NAME, &command).context("could not write the startup entry")?;
        Ok(command)
    }

    pub fn disable() -> Result<()> {
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error).context("could not open the per-user startup key"),
        };
        match key.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("could not remove the startup entry"),
        }
    }

    pub fn current() -> Result<Option<String>> {
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("could not open the per-user startup key"),
        };
        match key.get_value::<String, _>(VALUE_NAME) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).context("could not read the startup entry"),
        }
    }

    /// Hides the console window once the agent is ready to live in the tray.
    /// This is used both by the Run key and by a paired agent opened with a
    /// double-click.
    ///
    /// Deliberately hidden rather than freed: `FreeConsole` invalidates stdout, and
    /// Rust's `println!` panics when a write fails, so the agent would die on the
    /// first line it printed. That failure only ever appears at login, which is
    /// exactly where nobody is watching.
    pub fn release_console() {
        use windows::Win32::System::Console::GetConsoleWindow;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

        // Safety: both calls take a handle this process owns, and GetConsoleWindow
        // returns a null handle when there is no console, which ShowWindow ignores.
        unsafe {
            let window = GetConsoleWindow();
            if window != windows::Win32::Foundation::HWND::default() {
                let _ = ShowWindow(window, SW_HIDE);
            }
        }
    }

    /// True when this process owns the console it is attached to. Explorer makes
    /// exactly that one-process console for a double-click; a terminal also has
    /// its shell attached, so commands such as `corin-agent status` stay visible.
    pub fn owns_console() -> bool {
        use windows::Win32::System::Console::GetConsoleProcessList;

        let mut processes = [0_u32; 2];
        // A one-entry result means only this process is attached. Supplying two
        // slots also lets Windows report "at least two" without allocating.
        unsafe { GetConsoleProcessList(&mut processes) == 1 }
    }
}

#[cfg(not(windows))]
mod platform {
    use anyhow::{bail, Result};

    pub fn enable() -> Result<String> {
        bail!("starting with the machine is only wired up for Windows so far")
    }

    pub fn disable() -> Result<()> {
        Ok(())
    }

    pub fn current() -> Result<Option<String>> {
        Ok(None)
    }

    pub fn release_console() {}

    pub fn owns_console() -> bool {
        false
    }
}

pub use platform::{current, disable, enable, owns_console, release_console};

pub fn is_enabled() -> bool {
    current().unwrap_or(None).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_the_current_entry_never_fails_on_a_clean_machine() {
        // Whatever this machine has, asking must not error.
        assert!(current().is_ok());
    }

    #[test]
    fn the_background_flag_is_what_main_looks_for() {
        assert!(BACKGROUND_FLAG.starts_with("--"));
    }
}
