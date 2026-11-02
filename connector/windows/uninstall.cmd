@echo off
rem Removes the QuickEntry connector. Settings and key in ProgramData are kept unless you add -RemoveData.
net session >nul 2>&1
if errorlevel 1 (
  set "QE_ARGS=%*"
  powershell -NoProfile -Command "$a = $env:QE_ARGS; if ($a) { Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList $a } else { Start-Process -Verb RunAs -FilePath '%~f0' }"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
pause
