# Unit-test the runtime door state machine without launching the game.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Visual Studio C++ x86 tools are required.' }
$devCmd = Join-Path $vs 'Common7\Tools\VsDevCmd.bat'
$lines = & cmd.exe /d /s /c "`"$devCmd`" -no_logo -arch=x86 -host_arch=x64 >nul 2>nul && set"
if ($LASTEXITCODE) { throw 'Could not initialise the Visual Studio x86 environment.' }
foreach ($line in $lines) {
    $split = $line.IndexOf('=')
    if ($split -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0,$split),$line.Substring($split+1),'Process') }
}
$out = Join-Path $root 'build\door-state-tests'
New-Item -ItemType Directory -Force $out | Out-Null
$includes = @('runtime\sdk\include','runtime\src\host','runtime\src\sdk','runtime\src\maps','runtime\src\engine') | ForEach-Object { '/I' + (Join-Path $root $_) }
$exe = Join-Path $out 'door-state.exe'
& cl.exe /nologo /W4 /WX /O2 /DMH_DOOR_STATE_TEST @includes (Join-Path $root 'runtime\tests\door-state.c') (Join-Path $root 'runtime\src\maps\MHSwitches.c') "/Fe$exe" "/Fo$out/"
if ($LASTEXITCODE) { throw 'Door-state compilation failed.' }
& $exe
if ($LASTEXITCODE) { throw 'Door-state tests failed.' }
