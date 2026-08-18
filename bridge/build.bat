@echo off
REM ============================================================
REM  Build the x86 engine bridge.
REM  binDir is read from config.json, so moving the project
REM  to another machine requires only editing config.json.
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$c = Get-Content '%~dp0..\config.json' -Raw | ConvertFrom-Json; Write-Output $c.binDir"`) do set "BIN=%%i"
if not defined BIN (
  echo [ERROR] cannot read binDir from config.json
  exit /b 1
)
if not exist "%BIN%\Roche.LC120.Infrastructure.Interface.dll" (
  echo [ERROR] binDir not valid: %BIN%
  echo         edit config.json  -^> binDir  to point at the LC96 Bin folder
  exit /b 1
)

set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] 32-bit .NET Framework compiler not found: %CSC%
  exit /b 1
)

"%CSC%" /nologo /platform:x86 /out:"%~dp0engine-bridge.exe" ^
  /r:"%WINDIR%\Microsoft.NET\Framework\v4.0.30319\System.Web.Extensions.dll" ^
  /r:"%BIN%\Roche.LC120.Infrastructure.Interface.dll" ^
  /r:"%BIN%\Roche.LC120.Infrastructure.Services.dll" ^
  /r:"%BIN%\Roche.LC120.Core.DLL" ^
  /r:"%BIN%\Roche.DP.CalcPack.Tools.Data.dll" ^
  "%~dp0engine-bridge.cs"
if errorlevel 1 (
  echo [ERROR] bridge build failed
  exit /b 1
)
echo [OK] engine-bridge.exe built