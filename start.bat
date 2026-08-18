@echo off
REM ============================================================
REM  One-click start for qPCR Web.
REM  - checks Node.js
REM  - builds the x86 engine bridge if missing
REM  - starts the server and opens the browser
REM  Press Ctrl+C in this window to stop the server.
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)

if not exist "bridge\engine-bridge.exe" (
  echo [..] engine bridge not found - building...
  call "bridge\build.bat"
  if errorlevel 1 (
    echo [ERROR] bridge build failed. Check config.json binDir.
    pause
    exit /b 1
  )
)

echo [..] starting qPCR Web at http://localhost:8080
echo [..] (a browser window will open automatically)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8080"
node server.js