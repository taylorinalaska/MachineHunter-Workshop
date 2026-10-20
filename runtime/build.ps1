<#
.SYNOPSIS
  Builds MHRuntime.dll (32-bit) and the mods under mods\, and installs them into game\.

.DESCRIPTION
  Needs Visual Studio or the Build Tools with the "Desktop development with
  C++" workload (MSVC x86 and a Windows SDK). The runtime and the native mods
  are plain C with no C runtime dependency, so the DLLs are small and have
  nothing to redistribute.

  Each folder under mods\ is one mod package. Its mod.json, main.lua and
  assets are copied to game\mods\<id>\; if it has .c files they are compiled
  into mod.dll.

  Run from anywhere:  powershell -ExecutionPolicy Bypass -File runtime\build.ps1
  or simply:          npm run runtime:build

.PARAMETER NoInstall
  Leave everything in build\ instead of copying it into game\.

.PARAMETER RuntimeOnly
  Build MHRuntime.dll but not the mods.
#>
param(
    [switch]$NoInstall,
    [switch]$RuntimeOnly
)

$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot -Parent
$src     = Join-Path $PSScriptRoot 'src'
$sdk     = Join-Path $PSScriptRoot 'sdk\include'
$modsSrc = Join-Path $root 'mods'
$out     = Join-Path $root 'build\runtime'
$modsOut = Join-Path $root 'build\mods'
$objDir  = Join-Path $out 'obj'
$gameDir = Join-Path $root 'game'

function Import-VisualStudioX86 {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (!(Test-Path $vswhere)) { throw 'Visual Studio (or the Build Tools) was not found. Install the "Desktop development with C++" workload.' }
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$vs) { throw 'No Visual Studio installation with the C++ x86 tools was found.' }
    $devCmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
    # Import the x86 developer environment into this PowerShell process.
    $lines = & cmd.exe /d /s /c "`"$devCmd`" -no_logo -arch=x86 -host_arch=x64 >nul 2>nul && set"
    if ($LASTEXITCODE) { throw 'Could not initialise the Visual Studio x86 environment.' }
    foreach ($line in $lines) {
        $split = $line.IndexOf('=')
        if ($split -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $split), $line.Substring($split + 1), 'Process') }
    }
}

Import-VisualStudioX86
New-Item -ItemType Directory -Force $objDir | Out-Null

# The generated headers must match gamedata\*.json before compiling.
Push-Location $root
try {
    & npx --no-install tsx scripts/gen-runtime-headers.ts
    if ($LASTEXITCODE) { throw 'Header generation failed.' }
} finally { Pop-Location }

# ---------------------------------------------------------------- runtime
$includes = @($sdk) + (Get-ChildItem $src -Directory | ForEach-Object { $_.FullName }) | ForEach-Object { "/I$_" }
$sources  = Get-ChildItem $src -Recurse -Filter *.c | Sort-Object FullName
$objects  = @()
foreach ($file in $sources) {
    $object = Join-Path $objDir ($file.BaseName + '.obj')
    # /GS- and /Zl: no CRT; the runtime resolves the few Win32 calls it needs itself.
    & cl.exe /nologo /c /W4 /WX /O2 /GS- /Zl /DMH_RUNTIME_CORE @includes "/Fo$object" $file.FullName
    if ($LASTEXITCODE) { throw "Compilation failed: $($file.Name)" }
    $objects += $object
}

$dll = Join-Path $out 'MHRuntime.dll'
& link.exe /nologo /dll /nodefaultlib /machine:x86 /entry:DllMain@12 `
    /export:MHRuntimeInit=_MHRuntimeInit@0 `
    "/implib:$out\MHRuntime.lib" "/out:$dll" @objects
if ($LASTEXITCODE) { throw 'Linking MHRuntime.dll failed.' }
Write-Host "Built $dll ($((Get-Item $dll).Length) bytes)"

if (!$NoInstall) {
    if (!(Test-Path $gameDir)) { throw "The game folder is missing: $gameDir" }
    Copy-Item $dll (Join-Path $gameDir 'MHRuntime.dll') -Force
    Write-Host "Installed to $gameDir\MHRuntime.dll"
}

# ------------------------------------------------------------------- mods
if (!$RuntimeOnly -and (Test-Path $modsSrc)) {
    # memcpy/memset for code built without the C runtime.
    $support = Join-Path $src 'host\MHRuntimeMemory.c'
    foreach ($mod in Get-ChildItem $modsSrc -Directory | Sort-Object Name) {
        if (!(Test-Path (Join-Path $mod.FullName 'mod.json'))) { continue }
        $build = Join-Path $modsOut $mod.Name
        New-Item -ItemType Directory -Force $build | Out-Null

        $code = @(Get-ChildItem $mod.FullName -Filter *.c | Sort-Object Name)
        $modDll = $null
        if ($code.Count) {
            $modObjects = @()
            foreach ($file in $code + (Get-Item $support)) {
                $object = Join-Path $build ($file.BaseName + '.obj')
                & cl.exe /nologo /c /W4 /WX /O2 /GS- /Zl "/I$sdk" "/I$($mod.FullName)" "/Fo$object" $file.FullName
                if ($LASTEXITCODE) { throw "Compilation failed: mods\$($mod.Name)\$($file.Name)" }
                $modObjects += $object
            }
            $modDll = Join-Path $build 'mod.dll'
            & link.exe /nologo /dll /nodefaultlib /noentry /machine:x86 /export:MHModInit=_MHModInit@4 `
                "/implib:$build\mod.lib" "/out:$modDll" @modObjects
            if ($LASTEXITCODE) { throw "Linking mods\$($mod.Name)\mod.dll failed." }
        }

        if (!$NoInstall) {
            $target = Join-Path $gameDir "mods\$($mod.Name)"
            New-Item -ItemType Directory -Force $target | Out-Null
            # Replace the package's own files; anything else in the folder is left alone.
            foreach ($name in 'mod.json', 'mod.dll', 'main.lua') {
                $old = Join-Path $target $name
                if (Test-Path $old) { Remove-Item $old -Force }
            }
            Copy-Item (Join-Path $mod.FullName 'mod.json') $target -Force
            $script = Join-Path $mod.FullName 'main.lua'
            if (Test-Path $script) { Copy-Item $script $target -Force }
            if ($modDll) { Copy-Item $modDll $target -Force }
            $assets = Join-Path $mod.FullName 'assets'
            if (Test-Path $assets) { Copy-Item $assets $target -Recurse -Force }
        }
        $kind = if ($modDll) { 'native' } elseif (Test-Path (Join-Path $mod.FullName 'main.lua')) { 'Lua' } else { 'data' }
        Write-Host ("Mod {0,-14} {1}{2}" -f $mod.Name, $kind, $(if ($NoInstall) { '' } else { ' -> game\mods' }))
    }
}
