# Removes the QuickEntry connector task and program files.
# Settings, key and log in C:\ProgramData\QuickEntry are kept unless -RemoveData is given.
# Nothing in TallyPrime or in the cloud is changed.
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'QuickEntry'),
  [string]$DataDir = (Join-Path $env:ProgramData 'QuickEntry'),
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$TaskName = 'QuickEntry Connector'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run this as administrator.' -ForegroundColor Red; exit 1 }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "  OK    Removed scheduled task '$TaskName'"
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$InstallDir*connector*index.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# This script may be running from inside InstallDir; remove the program folders, then the rest on a best-effort basis.
foreach ($sub in @('connector', 'app', 'package.json', 'check.cmd')) {
  $p = Join-Path $InstallDir $sub
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  OK    Removed program files from $InstallDir"

if ($RemoveData) {
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "  OK    Removed settings, key and log from $DataDir"
} else {
  Write-Host "  NOTE  Kept settings, key and log in $DataDir (run with -RemoveData to delete them)"
}
