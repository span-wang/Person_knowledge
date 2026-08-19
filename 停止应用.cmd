@echo off
setlocal
cd /d "%~dp0"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
set "exitCode=%errorlevel%"

echo.
if not "%exitCode%"=="0" (
  echo Stop failed. Review the errors above.
) else (
  echo Application services stopped. MySQL is still running.
)
echo Press any key to close this window.
pause >nul
exit /b %exitCode%
