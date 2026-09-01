//! Where the agent's output goes when the binary itself has no console.
//!
//! The executable is built for the windows subsystem, so Windows never creates a
//! console for it and a login never flashes a black rectangle on the way to the
//! tray. That leaves the two moments somebody is actually reading: a command
//! typed into a terminal, which wants that terminal's console, and a first
//! double-click, which has to ask for a pairing code and so needs one of its own.
//!
//! Printing without either is safe. `GetStdHandle` returns null when a process
//! has no console, and the standard library reports that as a successful write of
//! nothing, so `println!` is a no-op rather than the panic that made freeing a
//! console unworkable.

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HWND};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Console::{
        AllocConsole, AttachConsole, GetConsoleWindow, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_HANDLE,
        STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    /// Whether the console on screen is one the agent asked for. A terminal's
    /// console belongs to the person who opened it and is never hidden or waited on.
    static OURS: AtomicBool = AtomicBool::new(false);

    /// Adopts the console of whatever launched this, when there is one. True for a
    /// command typed into a terminal, false for a double-click and for the login.
    pub fn attach_to_terminal() -> bool {
        // Safety: the parent either has a console to join or it does not, which is
        // the error this ignores.
        if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) }.is_err() {
            return false;
        }
        redirect_missing_handles();
        true
    }

    /// Makes sure there is somewhere to print to and read from, creating a console
    /// when the agent was double-clicked. True once one exists.
    pub fn open() -> bool {
        if window().is_some() {
            return true;
        }
        // Safety: allocating the one console this process may have.
        if unsafe { AllocConsole() }.is_err() {
            return false;
        }
        OURS.store(true, Ordering::Relaxed);
        redirect_missing_handles();
        true
    }

    pub fn is_ours() -> bool {
        OURS.load(Ordering::Relaxed)
    }

    /// Hides the console the agent created, once it has served its purpose. The
    /// window goes, the handles stay valid, so later printing still cannot panic.
    pub fn hide() {
        if !is_ours() {
            return;
        }
        let Some(window) = window() else {
            return;
        };
        // Safety: a window handle this process owns.
        unsafe {
            let _ = ShowWindow(window, SW_HIDE);
        }
    }

    /// HWND has no is_invalid of its own, and a process without a console gets a
    /// null handle back rather than an error.
    fn window() -> Option<HWND> {
        // Safety: takes nothing and reports the absence of a console as null.
        let window = unsafe { GetConsoleWindow() };
        (window != HWND::default()).then_some(window)
    }

    /// Windows leaves the standard handles empty for a windows-subsystem process
    /// and fills them in only where the launcher redirected them. Replacing just
    /// the empty ones is what keeps `corin-agent status > file` writing to the file
    /// instead of to the console it has only now joined.
    fn redirect_missing_handles() {
        adopt(STD_INPUT_HANDLE, w!("CONIN$"), Access::Read);
        adopt(STD_OUTPUT_HANDLE, w!("CONOUT$"), Access::Write);
        adopt(STD_ERROR_HANDLE, w!("CONOUT$"), Access::Write);
    }

    enum Access {
        Read,
        Write,
    }

    fn adopt(id: STD_HANDLE, name: PCWSTR, access: Access) {
        if has_handle(id) {
            return;
        }

        // A console write handle is opened for reading too, which is what the
        // console API expects of anything that may want to query the screen buffer.
        let rights = match access {
            Access::Read => GENERIC_READ.0,
            Access::Write => GENERIC_READ.0 | GENERIC_WRITE.0,
        };

        // Safety: a console pseudo-file named by a constant, with no security
        // attributes and no template, which is the documented way to reach the
        // console this process just attached to or allocated.
        let opened = unsafe {
            CreateFileW(
                name,
                rights,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };

        if let Ok(handle) = opened {
            if !handle.is_invalid() {
                // Safety: the handle was opened above and is owned by the process
                // from here on, which is exactly what a standard handle is.
                let _ = unsafe { SetStdHandle(id, handle) };
            }
        }
    }

    fn has_handle(id: STD_HANDLE) -> bool {
        // Safety: one of the three ids the API defines.
        match unsafe { GetStdHandle(id) } {
            Ok(handle) => !handle.is_invalid(),
            Err(_) => false,
        }
    }
}

#[cfg(not(windows))]
mod platform {
    /// Everywhere else the process is started from a shell that already gave it
    /// the three standard streams, so there is nothing to attach or create.
    pub fn attach_to_terminal() -> bool {
        true
    }

    pub fn open() -> bool {
        true
    }

    pub fn is_ours() -> bool {
        false
    }

    pub fn hide() {}
}

pub use platform::{attach_to_terminal, hide, is_ours, open};
