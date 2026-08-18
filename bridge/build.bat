@echo off
REM Compile the x86 engine bridge (requires .NET Framework 4.x, 32-bit csc)
set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
set BIN=%~dp0..\..\Bin
if not exist "%CSC%" (echo csc.exe not found & exit /b 1)
"%CSC%" /nologo /platform:x86 /out:"%~dp0engine-bridge.exe" ^
  /r:"%WINDIR%\Microsoft.NET\Framework\v4.0.30319\System.Web.Extensions.dll" ^
  /r:"%BIN%\Roche.LC120.Infrastructure.Interface.dll" ^
  /r:"%BIN%\Roche.LC120.Infrastructure.Services.dll" ^
  /r:"%BIN%\Roche.LC120.Core.DLL" ^
  /r:"%BIN%\Roche.DP.CalcPack.Tools.Data.dll" ^
  "%~dp0engine-bridge.cs"
echo build done: %~dp0engine-bridge.exe