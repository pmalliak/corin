# Installs the locally built agent as the one Windows actually starts at login.
#
# The Run key points at a copy under %LOCALAPPDATA%\Corin, not at the build in
# agent/target/release, so a rebuild alone never reaches the machine: the login
# keeps launching whatever was copied there last. This script closes that gap in
# one command, and fixes the two things that go quiet when it is done by hand.
#
# The first is the startup entry itself, which is repointed when it names some
# other binary. The second is the tray icon: Windows 11 keys a notification icon's
# visibility to the executable's path, so an icon from a new path starts hidden in
# the overflow however many times it has been promoted from an older one.
#
# That second one can only be repaired for a path Windows already knows. It writes
# the NotifyIconSettings entry on its own schedule, minutes after the icon first
# appears rather than with it, so a genuinely new path has nothing to promote yet
# and has to be dragged out of the overflow once by hand. Running this again later
# finds the entry and makes it stick.
#
# Run it from the desktop session that should end up with the icon.
#
#   powershell -ExecutionPolicy Bypass -File scripts/install-agent.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-agent.ps1 -SkipBuild

[CmdletBinding()]
param(
    # For a binary that was just built, or one built somewhere else.
    [switch] $SkipBuild,
    [string] $InstallDirectory = (Join-Path $env:LOCALAPPDATA "Corin")
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$built = Join-Path $root "agent\target\release\corin-agent.exe"
$installed = Join-Path $InstallDirectory "corin-agent.exe"

$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValue = "Corin Agent"
$notifyKey = "HKCU:\Control Panel\NotifyIconSettings"

function Stop-Agent {
    $running = @(Get-Process -Name corin-agent -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }

    Write-Host ("Stopping {0} running agent process(es)." -f $running.Count)
    $running | Stop-Process -Force
    foreach ($process in $running) { [void] $process.WaitForExit(5000) }
}

function Start-Agent {
    Start-Process -FilePath $installed -ArgumentList "--background"

    for ($attempt = 1; $attempt -le 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Get-Process -Name corin-agent -ErrorAction SilentlyContinue) { return }
    }
    # --background is also what keeps a failure quiet, so the way to see one is to
    # drop the flag and let the agent print.
    throw "the agent did not stay running. Run it without --background to see why."
}

# Windows holds the image open while it runs, so the copy is retried rather than
# assuming the process died on the first millisecond it was asked to.
function Copy-Agent {
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            Copy-Item -Path $built -Destination $installed -Force
            return
        } catch {
            if ($attempt -eq 10) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
}

# The subkey name is a hash Windows owns, so the executable path is what finds it.
function Get-TrayIconEntry {
    if (-not (Test-Path $notifyKey)) { return $null }
    Get-ChildItem $notifyKey | Where-Object {
        (Get-ItemProperty -Path $_.PSPath).ExecutablePath -eq $installed
    } | Select-Object -First 1
}

if (-not $SkipBuild) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw "cargo is not on PATH. Install the Rust toolchain, or pass -SkipBuild to install an existing build."
    }
    Write-Host "Building the agent."
    Push-Location (Join-Path $root "agent")
    try {
        cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $built)) {
    throw "no build at $built. Run this without -SkipBuild."
}

Stop-Agent

New-Item -ItemType Directory -Force -Path $InstallDirectory | Out-Null
Copy-Agent
Write-Host ("Installed {0:N0} bytes to {1}" -f (Get-Item $installed).Length, $installed)

# Before the start, because Explorer reads that value when the icon is created.
$entry = Get-TrayIconEntry
if (-not $entry) {
    Write-Host "Windows has no tray icon on record for this path yet. If the icon is hidden, drag it out of the overflow once and it stays out."
} elseif ((Get-ItemProperty -Path $entry.PSPath).IsPromoted -eq 1) {
    Write-Host "Tray icon is already out of the overflow."
} else {
    New-ItemProperty -Path $entry.PSPath -Name "IsPromoted" -Value 1 -PropertyType DWord -Force | Out-Null
    Write-Host "Tray icon moved out of the overflow."
}

Start-Agent

$startup = (Get-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue).$runValue
$expected = '"{0}" --background' -f $installed
if (-not $startup) {
    Write-Host "This machine does not start Corin at login. Run: corin-agent autostart on"
} elseif ($startup -ne $expected) {
    Set-ItemProperty -Path $runKey -Name $runValue -Value $expected
    Write-Host "Startup entry repointed at the installed copy. It named:"
    Write-Host ("  {0}" -f $startup)
}

$agent = Get-Process -Name corin-agent -ErrorAction SilentlyContinue
Write-Host ("Running as PID {0}. Right-click the tray icon to confirm." -f $agent.Id)
