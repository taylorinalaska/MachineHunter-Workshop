@echo off
setlocal
cd /d "%~dp0"
set "NODE=tools\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" scripts\setup-game.mjs %*
if errorlevel 1 (
  echo.
  echo Setup did not finish. See the message above and README.md.
  pause
  exit /b 1
)
pause
