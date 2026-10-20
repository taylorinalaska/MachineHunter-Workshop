<#
.SYNOPSIS
  Runs the automated in-game checks and reports PASS/FAIL for each.

.DESCRIPTION
  Builds two test maps (scripts/game-checks.ts), installs them with a
  checking script (runtime/tests/game-checks) as a temporary mod, and plays
  them in the real game four times:

    main      walks the player up ramps, onto a hazard floor, into diagonal
              walls and a split-floor edge, against a wall added to a retail
              prop, through teleporters and out of the exit; watches robots
              and people on each kind of route; fights a robot with passive
              enemies on and off while the runtime trace records; opens the
              Mod Menu and rebinds its key; flies the free camera and pauses
              the world with Developer Tools.
    second    a MILIT3 map that starts in its second area, with tanks on
              routes.
    custom    a map with a custom enemy (a made-over Four Foot): its own
              health, harder-hitting shots and a new look.
    friends   a friendly robot that follows the player: it does not shoot,
              keeps up, wanders, and is brought back when left behind.
    fight     a friend and a tough enemy shoot each other, and the friend
              dies when its health runs out.
    battle    two friends against two enemies: all must get hurt, the game
              must carry on.
    doors     doors that open on touch, as a pair, with a key and with a switch.
    pause     Enter in the pause menu: CONTINUE resumes, QUIT asks first, YES leaves the level.
    controls  the Controls mod moves Forward and Pause to other keys, and puts them back.
    display   (not by default) screenshots of the intro movies, fullscreen and the window.
    props     (not by default) screenshots of every prop part shape and the prop presets.
    hud       (not by default) screenshots of the in-game interface, a key and the continue screen.
    disabled  starts with Free Camera switched off and checks the rest load.
    effects   (only when asked for) custom effects spawning every particle of
              the engine's effect table, one map per 96.
    themes    (only when asked for) a plain custom map on each of the 17
              retail themes, each of which must load and play.
    menu      goes through the main menu to MAPS with more than eight maps
              installed, pages on, and starts the first map of page two.

  The checking script cannot press keys, so it writes requests to the
  runtime log and this script presses them. The game window takes the
  keyboard and the foreground while this runs: leave the PC alone until it
  finishes (about five minutes).

  Screenshots, the log of each run and report.txt go to build\game-checks.
  The temporary mod is removed and mods\settings.cfg restored afterwards.
  The exit code is the number of failed checks.

  Needs the runtime and mods installed (npm run runtime:build).

.PARAMETER Only
  Use -Only ramps for the ramp transition regression checks.
  Run just these phases: main, second, custom, disabled, menu, themes. The default
  is all but themes.
#>
param(
    [string[]]$Only = @('main', 'second', 'custom', 'friends', 'fight', 'battle', 'doors', 'triggers', 'pause', 'controls', 'disabled', 'menu'),
    [ValidateSet("", "east", "west", "north", "south")]
    [string]$RampDirection = "",
    [string]$DoorProject = "",
    [int]$Timeout = 240
)

$ErrorActionPreference = 'Stop'
# powershell -File passes "main,second" as one string.
$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$root   = Split-Path $PSScriptRoot -Parent
$game   = Join-Path $root 'game'
$out    = Join-Path $root 'build\game-checks'
$stage  = Join-Path $out 'stage'
$modDir = Join-Path $game 'mods\game-checks'
$log    = Join-Path $game 'logs\mh-runtime.log'
$settings = Join-Path $game 'mods\settings.cfg'

if (Get-Process -Name 'MACHHUNT' -ErrorAction SilentlyContinue) { throw 'The game is already running. Close it first.' }
if (!(Test-Path (Join-Path $game 'MHRuntime.dll'))) { throw 'game\MHRuntime.dll is missing. Run npm run runtime:build first.' }

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MhCheck {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, int size, out IntPtr read);
    public static uint TerrainFaces(IntPtr process) { byte[] data = new byte[4]; IntPtr read; return ReadProcessMemory(process, new IntPtr(0x00658F30), data, 4, out read) ? BitConverter.ToUInt32(data, 0) : 0; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    /// The largest visible top-level window owned by a process.
    public static IntPtr MainWindow(uint pid) {
        IntPtr best = IntPtr.Zero; int bestArea = 0;
        EnumWindows((hwnd, l) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner != pid || !IsWindowVisible(hwnd)) return true;
            RECT r; GetClientRect(hwnd, out r);
            int area = (r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = hwnd; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
"@

$results = New-Object System.Collections.Generic.List[string]

function Write-Result([string]$line) {
    $results.Add($line)
    $color = if ($line.StartsWith('PASS')) { 'Green' } elseif ($line.StartsWith('FAIL')) { 'Red' } else { 'Gray' }
    Write-Host $line -ForegroundColor $color
}

# Windows lets a program take the foreground only in some circumstances; a tap of Alt
# (VK_MENU 0x12) is the usual way to qualify. Without the foreground the game ignores the keys.
$script:focusWarned = $false
function Focus($process) {
    $hwnd = [MhCheck]::MainWindow([uint32]$process.Id)
    if ($hwnd -eq [IntPtr]::Zero) { return $hwnd }
    if ([MhCheck]::GetForegroundWindow() -ne $hwnd) {
        [MhCheck]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [MhCheck]::SetForegroundWindow($hwnd) | Out-Null
        [MhCheck]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        if ([MhCheck]::GetForegroundWindow() -ne $hwnd -and -not $script:focusWarned) {
            $script:focusWarned = $true
            Write-Result 'INFO the game window could not take the foreground; checks that press keys may fail'
        }
    }
    return $hwnd
}

# Hold keys together for $ms, then release them.
function Press($process, [int[]]$keys, [int]$ms = 150) {
    Focus $process | Out-Null
    Start-Sleep -Milliseconds 120
    foreach ($k in $keys) { [MhCheck]::keybd_event([byte]$k, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds $ms
    foreach ($k in $keys) { [MhCheck]::keybd_event([byte]$k, 0, 2, [UIntPtr]::Zero) }
}

function Shot($process, [string]$name) {
    if ($name.StartsWith('usergeometry-')) {
        $faces = [MhCheck]::TerrainFaces($process.Handle)
        $result = if ($faces -gt 0 -and $faces -lt 2047) { 'PASS' } else { 'FAIL' }
        Write-Result "$result terrain stays below the face limit at $name | $faces / 2047"
    }
    $hwnd = [MhCheck]::MainWindow([uint32]$process.Id)
    if ($hwnd -eq [IntPtr]::Zero) { return }
    $rect = New-Object MhCheck+RECT
    [MhCheck]::GetClientRect($hwnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) { return }
    $bitmap = New-Object System.Drawing.Bitmap $w, $h
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    [MhCheck]::PrintWindow($hwnd, $hdc, 3) | Out-Null
    $graphics.ReleaseHdc($hdc); $graphics.Dispose()
    $bitmap.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose()
    Write-Host "  screenshot $name.png" -ForegroundColor DarkGray
}

# Lines added to the runtime log since the last call. The game keeps the file open, so share it.
$script:logPosition = 0
$script:logPartial = ''
function Read-Log {
    if (!(Test-Path $log)) { return @() }
    $stream = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite, Delete')
    try {
        if ($stream.Length -lt $script:logPosition) { $script:logPosition = 0 }
        $stream.Seek($script:logPosition, 'Begin') | Out-Null
        $reader = New-Object IO.StreamReader($stream)
        $text = $script:logPartial + $reader.ReadToEnd()
        $script:logPosition = $stream.Position
    } finally { $stream.Dispose() }
    $lines = $text -split "`r?`n"
    $script:logPartial = $lines[-1]
    if ($lines.Count -gt 1) { return $lines[0..($lines.Count - 2)] }
    return @()
}

function Start-Game([string]$map) {
    # A game that is still shutting down keeps the log open, and the next one could not write it.
    for ($i = 0; (Test-Path $log) -and $i -lt 40; $i++) {
        Remove-Item $log -ErrorAction SilentlyContinue
        if (Test-Path $log) { Start-Sleep -Milliseconds 250 }
    }
    if (Test-Path $log) { throw 'The runtime log is still in use by an earlier game.' }
    $script:logPosition = 0; $script:logPartial = ''
    if ($map) { $env:MH_AUTOSTART_MAP = $map } else { Remove-Item Env:MH_AUTOSTART_MAP -ErrorAction SilentlyContinue }
    # Without a map the game shows its launcher dialog; the runtime confirms it.
    $env:MH_SKIP_LAUNCHER = '1'
    return Start-Process -FilePath (Join-Path $game 'MACHHUNT.EXE') -WorkingDirectory $game -PassThru
}

function Stop-Game($process, [string]$phase) {
    if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
    $process.WaitForExit(10000) | Out-Null
    for ($i = 0; (Get-Process -Name 'MACHHUNT' -ErrorAction SilentlyContinue) -and $i -lt 40; $i++) { Start-Sleep -Milliseconds 250 }
    if (Test-Path $log) { Copy-Item $log (Join-Path $out "$phase.log") -Force }
}

# Serve the checking script's requests until it says DONE.
function Serve($process, [string]$phase) {
    $deadline = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) { Write-Result "FAIL $phase run | the game exited with code $($process.ExitCode)"; return }
        foreach ($line in Read-Log) {
            if ($line -match 'MH Lua (load|initialization|callback) error') { Write-Result "FAIL $phase run | $line"; foreach ($more in Read-Log) { Write-Host "  $more" }; return }
            if ($line -notmatch '^\[CHECK\] (\w+) ?(.*)$') { continue }
            $kind = $Matches[1]; $rest = $Matches[2]
            switch ($kind) {
                'KEYS' {
                    $parts = $rest -split ' '
                    Press $process ([int[]]($parts[0] -split '\+')) ([int]$parts[1])
                }
                'SHOT' { Shot $process "$phase-$rest" }
                'DONE' { Write-Host "  $phase run: $rest" -ForegroundColor DarkGray; return }
                default { Write-Result "$kind $rest" }
            }
        }
        Start-Sleep -Milliseconds 80
    }
    Write-Result "FAIL $phase run | timed out after $Timeout s"
}

function Wait-Log([string]$pattern, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    $seen = @()
    while ((Get-Date) -lt $deadline) {
        $lines = @(Read-Log)
        $seen += $lines
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match $pattern) { return ,$seen } }
        Start-Sleep -Milliseconds 150
    }
    return $null
}

# ------------------------------------------------------------------ set up
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem (Join-Path $out '*') -File -Include *.png, *.log, report.txt -ErrorAction SilentlyContinue | Remove-Item -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Push-Location $root
try {
    $extra = @()
    if ($Only -contains 'themes') { $extra += '--themes' }
    if ($Only -contains 'ramps') { $extra += '--ramp-regressions' }
    if ($RampDirection) { $extra += '--ramp-direction'; $extra += $RampDirection }
    if ($Only -contains 'effects') { $extra += '--effects' }
    if ($DoorProject) { $extra += '--door-project'; $extra += $DoorProject }
    & npx --no-install tsx scripts/game-checks.ts $stage --copies 6 @extra
    if ($LASTEXITCODE) { throw 'Building the test map failed.' }
} finally { Pop-Location }

$settingsBackup = if (Test-Path $settings) { [IO.File]::ReadAllText($settings) } else { $null }
# The checks press the original game's keys: runs leave out a key layout chosen with the Controls
# mod. The file is put back as it was at the end.
$testSettings = if ($settingsBackup) { [regex]::Replace($settingsBackup, '(?ms)^\[controls\]\s*$.*?(?=^\[|\z)', '') } else { '' }
[IO.File]::WriteAllText($settings, $testSettings)
New-Item -ItemType Directory -Force (Join-Path $modDir 'maps') | Out-Null
Copy-Item (Join-Path $root 'runtime\tests\game-checks\*') $modDir -Force
Copy-Item (Join-Path $stage 'layout.lua') $modDir -Force
Copy-Item (Join-Path $stage 'maps\game-checks.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\second-area.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\custom-enemy.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\friend.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\fight.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\battle.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\doors.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\props.mhproject') (Join-Path $modDir 'maps') -Force
Copy-Item (Join-Path $stage 'maps\triggers.mhproject') (Join-Path $modDir 'maps') -Force
if ($DoorProject) { Copy-Item (Join-Path $stage 'maps\user-door.mhproject') (Join-Path $modDir 'maps') -Force }

try {
    if ($Only -contains 'ramps') {
        Write-Host 'ramps run: layer transitions and descent' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'ramps' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\game-checks.mhproject'
        try { Serve $process 'ramps'; Shot $process 'ramps-end' } finally { Stop-Game $process 'ramps' }
    }

    if ($Only -contains 'main') {
        Write-Host 'main run: the level' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'main' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\game-checks.mhproject'
        try { Serve $process 'main'; Shot $process 'main-end' } finally { Stop-Game $process 'main' }
    }

    if ($Only -contains 'second') {
        Write-Host 'second run: a map that starts in its second area' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'second' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\second-area.mhproject'
        try { Serve $process 'second'; Shot $process 'second-end' } finally { Stop-Game $process 'second' }
    }

    if ($Only -contains 'custom') {
        Write-Host 'custom run: a custom enemy' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'custom' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\custom-enemy.mhproject'
        try { Serve $process 'custom'; Shot $process 'custom-end' } finally { Stop-Game $process 'custom' }
    }

    if ($Only -contains 'friends') {
        Write-Host 'friends run: a friendly robot that follows the player' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'friends' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\friend.mhproject'
        try { Serve $process 'friends' } finally { Stop-Game $process 'friends' }
    }

    if ($Only -contains 'fight') {
        Write-Host 'fight run: a friend and an enemy fight it out' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'fight' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\fight.mhproject'
        try { Serve $process 'fight' } finally { Stop-Game $process 'fight' }
    }

    if ($Only -contains 'battle') {
        Write-Host 'battle run: two friends against two enemies' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'battle' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\battle.mhproject'
        try { Serve $process 'battle'; Shot $process 'battle-end' } finally { Stop-Game $process 'battle' }
    }

    if ($Only -contains 'usercorridor') {
        if (!$DoorProject) { throw '-Only usercorridor requires -DoorProject' }
        Set-Content (Join-Path $modDir 'phase.txt') 'usercorridor' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\user-door.mhproject'
        try { Serve $process 'usercorridor' } finally { Stop-Game $process 'usercorridor' }
    }

    if ($Only -contains 'usergeometry') {
        if (!$DoorProject) { throw '-Only usergeometry requires -DoorProject' }
        Set-Content (Join-Path $modDir 'phase.txt') 'usergeometry' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\user-door.mhproject'
        try { Serve $process 'usergeometry' } finally { Stop-Game $process 'usergeometry' }
    }

    if ($Only -contains 'userdoor') {
        if (!$DoorProject) { throw '-Only userdoor requires -DoorProject' }
        Set-Content (Join-Path $modDir 'phase.txt') 'userdoor' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\user-door.mhproject'
        try { Serve $process 'userdoor'; Shot $process 'userdoor-end' } finally { Stop-Game $process 'userdoor' }
    }

    if ($Only -contains 'doors') {
        Write-Host 'doors run: doors, keys and a switch' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'doors' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\doors.mhproject'
        try { Serve $process 'doors' } finally { Stop-Game $process 'doors' }
    }

    if ($Only -contains 'triggers') {
        Write-Host 'triggers run: a pad that breaks, retiles, plays an effect and reveals a robot' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'triggers' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\triggers.mhproject'
        try { Serve $process 'triggers' } finally { Stop-Game $process 'triggers' }
    }

    if ($Only -contains 'pause') {
        Write-Host 'pause run: Enter in the pause menu' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'pause' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\doors.mhproject'
        try { Serve $process 'pause' } finally { Stop-Game $process 'pause' }
    }

    if ($Only -contains 'controls') {
        Write-Host 'controls run: the Controls mod moves keys' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'controls' -Encoding ascii
        # A settings file giving Pause the Fire key, as a hand edit could: the game must leave it on Fire.
        $text = $testSettings
        [IO.File]::WriteAllText($settings, $text + "`r`n[controls]`r`npause = CTRL`r`n")
        $process = Start-Game 'mods\game-checks\maps\custom-enemy.mhproject'
        try { Serve $process 'controls' } finally { Stop-Game $process 'controls' }
        [IO.File]::WriteAllText($settings, $testSettings)
    }

    if ($Only -contains 'display') {
        # Not run by default: a normal start with the intro movies, then fullscreen and back.
        Write-Host 'display run: intro movies, fullscreen and the window' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'display' -Encoding ascii
        $text = $testSettings
        if ($text -match '(?m)^\s*disabled\s*=\s*(.*)$') { $text = $text -replace '(?m)^(\s*disabled\s*=\s*)(.*)$', '$1$2, skip-intros' }
        else { $text = "disabled = skip-intros`r`n" + $text }
        [IO.File]::WriteAllText($settings, $text)
        $process = Start-Game $null
        try { Serve $process 'display' } finally { Stop-Game $process 'display' }
        [IO.File]::WriteAllText($settings, $testSettings)
    }

    if ($Only -contains 'props') {
        # Not run by default: screenshots of built props from three places.
        Write-Host 'props run: every part shape and the prop presets' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'props' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\props.mhproject'
        try { Serve $process 'props' } finally { Stop-Game $process 'props' }
    }

    if ($Only -contains 'hud') {
        # Not run by default: screenshots of the in-game interface to look at.
        Write-Host 'hud run: the in-game interface, a key and the continue screen' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'hud' -Encoding ascii
        $process = Start-Game 'mods\game-checks\maps\doors.mhproject'
        try { Serve $process 'hud' } finally { Stop-Game $process 'hud' }
    }

    if ($Only -contains 'effects') {
        # Not run by default: one start per map of effect emitters.
        Write-Host 'effects run: every particle of the effect table, from custom effects' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'effects' -Encoding ascii
        foreach ($map in Get-ChildItem (Join-Path $stage 'maps') -Filter 'effects-*.mhproject') {
            Copy-Item $map.FullName (Join-Path $modDir 'maps') -Force
            $process = Start-Game "mods\game-checks\maps\$($map.Name)"
            try { Serve $process $map.BaseName } finally { Stop-Game $process $map.BaseName }
            Remove-Item (Join-Path $modDir "maps\$($map.Name)") -Force
        }
    }

    if ($Only -contains 'themes') {
        # Not run by default: one start per retail theme, about four minutes.
        Write-Host 'themes run: a plain custom map on every retail theme' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'theme' -Encoding ascii
        foreach ($map in Get-ChildItem (Join-Path $stage 'themes') -Filter *.mhproject) {
            Copy-Item $map.FullName (Join-Path $modDir 'maps') -Force
            $process = Start-Game "mods\game-checks\maps\$($map.Name)"
            try { Serve $process $map.BaseName } finally { Stop-Game $process $map.BaseName }
            Remove-Item (Join-Path $modDir "maps\$($map.Name)") -Force
        }
    }

    if ($Only -contains 'disabled') {
        Write-Host 'disabled run: Free Camera switched off' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'disabled' -Encoding ascii
        $text = $testSettings
        if ($text -match '(?m)^\s*disabled\s*=\s*(.*)$') { $text = $text -replace '(?m)^(\s*disabled\s*=\s*)(.*)$', '$1$2, free-camera' }
        else { $text = "disabled = free-camera`r`n" + $text }
        [IO.File]::WriteAllText($settings, $text)
        $process = Start-Game $null
        try { Serve $process 'disabled' } finally { Stop-Game $process 'disabled' }
        [IO.File]::WriteAllText($settings, $testSettings)
    }

    if ($Only -contains 'menu') {
        Write-Host 'menu run: MAPS with more than eight maps' -ForegroundColor Cyan
        Set-Content (Join-Path $modDir 'phase.txt') 'menu' -Encoding ascii
        Copy-Item (Join-Path $stage 'maps\page-test-*.mhproject') (Join-Path $modDir 'maps') -Force
        # What the menu should list: every installed map, sorted the way the runtime sorts them.
        $disabled = @()
        if ((Test-Path $settings) -and ((Get-Content $settings -Raw) -match '(?m)^\s*disabled\s*=\s*(.*)$')) { $disabled = $Matches[1] -split '[\s,]+' | Where-Object { $_ } }
        $names = Get-ChildItem (Join-Path $game 'mods') -Directory | Where-Object { $disabled -notcontains $_.Name -and (Test-Path (Join-Path $_.FullName 'mod.json')) } |
            ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'maps') -Filter *.mhproject -ErrorAction SilentlyContinue } |
            ForEach-Object { $_.BaseName }
        $sorted = [string[]]@($names | ForEach-Object { $_ })
        [Array]::Sort($sorted, [Comparison[string]]{ param($a, $b) [string]::CompareOrdinal($a.ToLowerInvariant(), $b.ToLowerInvariant()) })
        Write-Result ("INFO {0} maps installed: {1}" -f $sorted.Count, ($sorted -join ', '))
        if ($sorted.Count -le 8) { Write-Result 'FAIL MAPS paging | fewer than nine maps installed, nothing to page' }
        else {
            $expected = $sorted[7]   # seven maps to a page once there are more than eight
            $process = Start-Game $null
            try {
                Start-Sleep -Seconds 6
                Press $process @(13)                       # the launcher dialog's default button
                if (!(Wait-Log 'native MAPS row prepared' 40)) { Write-Result 'FAIL MAPS paging | the main menu did not appear' }
                else {
                    Start-Sleep -Seconds 3
                    Shot $process 'menu-main'
                    1..4 | ForEach-Object { Press $process @(40); Start-Sleep -Milliseconds 250 }
                    Press $process @(13)
                    Start-Sleep -Seconds 3
                    Shot $process 'menu-maps-page-1'
                    1..7 | ForEach-Object { Press $process @(40); Start-Sleep -Milliseconds 250 }
                    Start-Sleep -Milliseconds 500
                    Press $process @(13)
                    $paged = Wait-Log 'next page of maps' 5
                    Start-Sleep -Seconds 1
                    Start-Sleep -Seconds 1
                    Shot $process 'menu-maps-page-2'
                    if (!$paged) { Write-Result 'FAIL MAPS paging: the page row turns the page | no "next page" in the log' }
                    else {
                        Write-Result 'PASS MAPS paging: the page row turns the page'
                        # The new page opens with its first map highlighted.
                        Start-Sleep -Seconds 2
                        Press $process @(13)
                        $lines = Wait-Log 'validated and armed' 15
                        Start-Sleep -Milliseconds 500
                        if ($lines) { $lines += @(Read-Log) }
                        if (!$lines) { Write-Result "FAIL MAPS paging: a map on page two starts | nothing was started (expected $expected)" }
                        else {
                            $started = ($lines | Where-Object { $_ -match '\.mhproject$' } | Select-Object -Last 1)
                            $ok = $started -and ([IO.Path]::GetFileNameWithoutExtension($started) -eq $expected)
                            Write-Result ("{0} MAPS paging: a map on page two starts | started {1}, expected {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $started, $expected)
                        }
                    }
                }
            } finally { Stop-Game $process 'menu' }
        }
    }
} finally {
    Remove-Item Env:MH_AUTOSTART_MAP -ErrorAction SilentlyContinue
    if ($null -ne $settingsBackup) { [IO.File]::WriteAllText($settings, $settingsBackup) } elseif (Test-Path $settings) { Remove-Item $settings }
    Remove-Item $modDir -Recurse -Force -ErrorAction SilentlyContinue
}

$pass = @($results | Where-Object { $_.StartsWith('PASS') }).Count
$fail = @($results | Where-Object { $_.StartsWith('FAIL') }).Count
$results.Add("$pass passed, $fail failed")
$results | Set-Content (Join-Path $out 'report.txt') -Encoding utf8
Write-Host "$pass passed, $fail failed. Report, logs and screenshots: $out" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $fail
