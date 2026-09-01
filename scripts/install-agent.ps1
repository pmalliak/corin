# Installs the locally built agent as the one Windows actually starts at login.
#
# The Run key points at a copy under %LOCALAPPDATA%\Corin, not at the build in
# agent/target/release, so a rebuild alone never reaches the machine: the login
# keeps launching whatever was copied there last. This script closes that gap in
# one command, and fixes the two things that go quiet when it is done by hand.
#
# The first is the startup entry itself, which is repointed when it names some
# other binary. The second is the tray icon. Windows 11 keys a notification icon's
# visibility to the executable's path, so an icon from a new path starts hidden in
# the overflow however many times it has been promoted from an older one; the
# entry under NotifyIconSettings only exists once the agent has created the icon,
# which is why promoting it can need one more restart.
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

    # The tray icon is registered a moment after the process appears, so callers
    # that read the registry next need the agent to have got that far.
    for ($attempt = 1; $attempt -le 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Get-Process -Name corin-agent -ErrorAction SilentlyContinue) { return }
    }
    throw "the agent did not stay running, try it in a console without --background to see why"
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

# Promote before the start when the icon is already known, so the common case
# needs a single launch.
$entry = Get-TrayIconEntry
$promotedAlready = $false
if ($entry) {
    $current = (Get-ItemProperty -Path $entry.PSPath).IsPromoted
    if ($current -eq 1) {
        $promotedAlready = $true
    } else {
        New-ItemProperty -Path $entry.PSPath -Name "IsPromoted" -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host "Tray icon moved out of the overflow."
    }
}

Start-Agent

# A first install has no entry to promote until the agent has made its icon, and
# Explorer reads that value when the icon is created, so this one needs a restart.
if (-not $entry) {
    Start-Sleep -Seconds 2
    $entry = Get-TrayIconEntry
    if ($entry -and (Get-ItemProperty -Path $entry.PSPath).IsPromoted -ne 1) {
        New-ItemProperty -Path $entry.PSPath -Name "IsPromoted" -Value 1 -PropertyType DWord -Force | Out-Null
        Write-Host "Tray icon registered, moving it out of the overflow."
        Stop-Agent
        Start-Agent
    } elseif (-not $entry) {
        Write-Host "Windows has not registered a tray icon for this path yet. If it is hidden, drag it out of the overflow once."
    }
} elseif ($promotedAlready) {
    Write-Host "Tray icon was already out of the overflow."
}

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
