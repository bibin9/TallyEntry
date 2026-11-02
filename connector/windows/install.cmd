@echo off
rem QuickEntry connector setup. Double-click; Windows asks for administrator rights.
net session >nul 2>&1
if errorlevel 1 (
  rem Keep the options (for example -NewKey) when Windows reopens this as administrator.
  set "QE_ARGS=%*"
  powershell -NoProfile -Command "$a = $env:QE_ARGS; if ($a) { Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList $a } else { Start-Process -Verb RunAs -FilePath '%~f0' }"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
