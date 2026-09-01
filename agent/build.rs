//! Embeds the two tray icons and the version block into the executable.
//!
//! They are resources rather than files beside the binary because the agent is
//! one downloaded .exe with nothing installed around it: an icon it cannot find
//! is an icon the tray cannot draw.
//!
//! Regenerate them from the branding art with `scripts/make-agent-icons.ps1`.

fn main() {
    println!("cargo:rerun-if-changed=assets/corin.ico");
    println!("cargo:rerun-if-changed=assets/corin-idle.ico");

    #[cfg(windows)]
    {
        let mut resource = winresource::WindowsResource::new();
        // Ordinal 1 is also what Explorer shows, since it takes the lowest id.
        resource.set_icon_with_id("assets/corin.ico", "1");
        resource.set_icon_with_id("assets/corin-idle.ico", "2");
        resource.set("FileDescription", "Corin agent");
        resource.set("ProductName", "Corin");
        if let Err(error) = resource.compile() {
            // A missing resource compiler must not stop a build on a machine that
            // only wants to run the tests, so this is a warning and not a panic.
            println!("cargo:warning=could not embed the agent resources: {error}");
        }
    }
}
