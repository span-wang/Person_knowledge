@echo off
setlocal
cd /d "%~dp0"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "exitCode=%errorlevel%"

echo.
if not "%exitCode%"=="0" (
  echo Startup failed. Review the errors above and .runtime\logs.
) else (
  echo Service started. Closing this window will not stop it.
)
echo Press any key to close this window.
pause >nul
exit /b %exitCode%
