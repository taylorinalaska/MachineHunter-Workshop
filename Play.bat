@echo off
setlocal
cd /d "%~dp0"
set "NODE=tools\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" scripts\launch.mjs game
if errorlevel 1 (
  pause
  exit /b 1
)
