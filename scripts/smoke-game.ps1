<#
.SYNOPSIS
  Starts the game, waits, saves a picture of its window and the runtime log, then closes it.

.DESCRIPTION
  A quick check that the patched executable and MHRuntime.dll still start and
  reach the front end after a rebuild. Output goes to build\smoke\.

.PARAMETER Seconds
  How long to let the game run before capturing.

.PARAMETER Keys
  Optional virtual-key codes to press before capturing, for example 0x0D for
  Return (which accepts the game's launcher dialog) or 0x72 for F3.
#>
param(
    [int]$Seconds = 20,
    # Comma-separated script: virtual-key codes to press and "wN" waits, e.g. "13,w6,13,w6,114".
    [string]$Keys = '',
    # Seconds to wait after each key press.
    [double]$KeyDelay = 0.5,
    # Seconds to wait after the last key before capturing.
    [int]$After = 0,
    [string]$Name = 'smoke',
    # A .mhproject path relative to the game folder to start directly, as the Workshop's Play button does
    # (for example mods\workshop\maps\workshop-demo.mhproject). Skips the launcher dialog and the menus.
    [string]$Map = '',
    # Capture a game that is already running (started by the Workshop's Play button, say) instead of starting one.
    [switch]$Attach
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$game = Join-Path $root 'game'
$out  = Join-Path $root 'build\smoke'
New-Item -ItemType Directory -Force $out | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MhSmoke {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);

    static string Text(IntPtr hwnd) { var sb = new System.Text.StringBuilder(2048); GetWindowText(hwnd, sb, sb.Capacity); return sb.ToString(); }

    /// Titles and child text of every visible window of a process (message boxes included).
    public static List<string> WindowTexts(uint pid) {
        var result = new List<string>();
        EnumWindows((hwnd, l) => {
            uint owner; GetWindowThreadProcessId(hwnd, out owner);
            if (owner != pid || !IsWindowVisible(hwnd)) return true;
            var parts = new List<string>();
            EnumChildWindows(hwnd, (child, l2) => { var t = Text(child); if (t.Length > 0) parts.Add(t); return true; }, IntPtr.Zero);
            result.Add("[" + Text(hwnd) + "] " + string.Join(" | ", parts));
            return true;
        }, IntPtr.Zero);
        return result;
    }

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

$log = Join-Path $game 'logs\mh-runtime.log'
if ($Map) { $env:MH_AUTOSTART_MAP = $Map } else { Remove-Item Env:MH_AUTOSTART_MAP -ErrorAction SilentlyContinue }
if ($Attach) {
    $process = Get-Process -Name 'MACHHUNT' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$process) { Write-Host 'No running game to attach to.'; exit 1 }
} else {
    Remove-Item $log -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath (Join-Path $game 'MACHHUNT.EXE') -WorkingDirectory $game -PassThru
}
try {
    Start-Sleep -Seconds $Seconds
    $process.Refresh()
    if ($process.HasExited) { Write-Host "The game exited on its own with code $($process.ExitCode)." }
    else {
        $hwnd = [MhSmoke]::MainWindow([uint32]$process.Id)
        if ($hwnd -eq [IntPtr]::Zero) { Write-Host 'The game is running but has no visible window.' }
        else {
            # Tokens are virtual-key codes to press, or "wN" to wait N seconds.
            foreach ($token in @($Keys -split '[ ,]+' | Where-Object { $_ })) {
                if ($token -match '^w(\d+(\.\d+)?)$') { Start-Sleep -Milliseconds ([int]([double]$Matches[1] * 1000)); continue }
                $hwnd = [MhSmoke]::MainWindow([uint32]$process.Id)
                [MhSmoke]::SetForegroundWindow($hwnd) | Out-Null
                Start-Sleep -Milliseconds 200
                [MhSmoke]::keybd_event([byte][int]$token, 0, 0, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds 350
                [MhSmoke]::keybd_event([byte][int]$token, 0, 2, [UIntPtr]::Zero)
                Start-Sleep -Milliseconds ([int]($KeyDelay * 1000))
            }
            if ($After -gt 0) {
                Start-Sleep -Seconds $After
                # The launcher dialog is replaced by the game window once a game starts.
                $hwnd = [MhSmoke]::MainWindow([uint32]$process.Id)
            }
            foreach ($line in [MhSmoke]::WindowTexts([uint32]$process.Id)) { Write-Host "window: $line" }
            $rect = New-Object MhSmoke+RECT
            [MhSmoke]::GetClientRect($hwnd, [ref]$rect) | Out-Null
            $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
            Write-Host "Game window: ${w}x${h}"
            if ($w -gt 0 -and $h -gt 0) {
                $bitmap = New-Object System.Drawing.Bitmap $w, $h
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                $hdc = $graphics.GetHdc()
                # 1 = client area only, 2 = render even when occluded
                [MhSmoke]::PrintWindow($hwnd, $hdc, 3) | Out-Null
                $graphics.ReleaseHdc($hdc); $graphics.Dispose()
                $picture = Join-Path $out "$Name.png"
                $bitmap.Save($picture, [System.Drawing.Imaging.ImageFormat]::Png); $bitmap.Dispose()
                Write-Host "Saved $picture"
            }
        }
    }
} finally {
    if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
}
if (Test-Path $log) { Copy-Item $log (Join-Path $out "$Name.log") -Force; Get-Content $log } else { Write-Host 'No runtime log was written.' }
