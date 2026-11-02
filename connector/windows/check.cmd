@echo off
rem Tests the connection to TallyPrime and the cloud, and shows the latest log lines.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
set "QE_DATA=%ProgramData%\QuickEntry"
set "QE_NODE=node.exe"
where node.exe >nul 2>&1 || set "QE_NODE=%ProgramFiles%\nodejs\node.exe"
set "QE_FLAGS="
"%QE_NODE%" --use-system-ca -e 0 >nul 2>&1 && set "QE_FLAGS=--use-system-ca"
"%QE_NODE%" %QE_FLAGS% "%~dp0connector\index.js" --config "%QE_DATA%\config.json" --check
echo.
powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName 'QuickEntry Connector' -ErrorAction SilentlyContinue; if ($t) { 'Background task: ' + $t.State } else { 'Background task: NOT INSTALLED' }"
echo.
echo Last log lines (%QE_DATA%\connector.log):
powershell -NoProfile -Command "if (Test-Path '%QE_DATA%\connector.log') { Get-Content '%QE_DATA%\connector.log' -Tail 15 } else { 'no log yet' }"
echo.
pause
