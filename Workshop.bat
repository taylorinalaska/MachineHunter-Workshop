@echo off
rem Starts the Machine Hunter Workshop and opens it in your browser.
setlocal
cd /d "%~dp0"

if exist "tools\node\node.exe" (
  "tools\node\node.exe" scripts\launch.mjs workshop
  pause
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first run...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)

if not exist "apps\workshop\dist\index.html" (
  echo Building the Workshop...
  call npm run build
  if errorlevel 1 ( pause & exit /b 1 )
)

node scripts\launch.mjs workshop
pause
