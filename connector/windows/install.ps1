# QuickEntry connector installer for Windows (run on the PC where TallyPrime is open).
#
# What it does:
#   1. Checks for Node.js 18 or later (offers to install Node.js LTS with winget if missing).
#   2. Copies the connector to C:\Program Files\QuickEntry.
#   3. Writes the settings to C:\ProgramData\QuickEntry (config.json, connector.key, connector.log).
#      That folder is readable only by SYSTEM and Administrators, so the key is not exposed.
#   4. Tests the connection to TallyPrime and to the cloud.
#   5. Registers a Windows scheduled task "QuickEntry Connector" that runs as SYSTEM at startup,
#      with no time limit, and is re-checked every 5 minutes so it starts again if it ever stops.
#
# Run it with install.cmd (it asks for administrator rights), or from an administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -TallyCompany "Al Noor Trading LLC" -RelayUrl "https://quickentry.pages.dev"
# Running it again upgrades the files and keeps the existing settings and key.

[CmdletBinding()]
param(
  [string]$TallyCompany,
  [string]$RelayUrl,
  [string]$TallyUrl = 'http://localhost:9000',
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'QuickEntry'),
  [string]$DataDir = (Join-Path $env:ProgramData 'QuickEntry'),
  [int]$IntervalSec = 30,
  [switch]$NewKey,      # ask for a new connector key even if one is already saved
  [switch]$NoStart      # install but do not start the task now
)

$ErrorActionPreference = 'Stop'
$TaskName = 'QuickEntry Connector'
$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Say($msg) { Write-Host $msg }
function Ok($msg) { Write-Host "  OK    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  NOTE  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  ERROR $msg" -ForegroundColor Red; exit 1 }
function WriteText($path, $text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false))) }

Say ''
Say 'QuickEntry connector setup'
Say '--------------------------'

# 1. Administrator rights
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'Please run this as administrator (right-click install.cmd > Run as administrator).' }

# 2. Source files present
foreach ($f in @('connector\index.js', 'app\core\connector-core.js', 'app\core\tally-xml.js')) {
  if (-not (Test-Path (Join-Path $SourceRoot $f))) { Fail "Missing $f next to the installer. Unzip the whole package first." }
}

# 3. Node.js
function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $p = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $p) { return $p }
  return $null
}
$node = Find-Node
if (-not $node) {
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    $ans = Read-Host 'Node.js is not installed. Install Node.js LTS now with winget? (Y/N)'
    if ($ans -match '^[Yy]') {
      & winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
      $node = Find-Node
    }
  }
  if (-not $node) { Fail 'Node.js 18 or later is needed. Install Node.js LTS from https://nodejs.org and run this again.' }
}
$ver = (& $node -v).Trim()
$major = [int]($ver.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail "Node.js $ver is too old. Install Node.js LTS (20 or later) from https://nodejs.org." }
Ok "Node.js $ver at $node"

# 4. Stop a running copy before replacing files
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$InstallDir*connector*index.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Ok 'Stopped the running connector for the upgrade'
}

# 5. Copy program files
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'connector'), (Join-Path $InstallDir 'app\core') | Out-Null
Copy-Item (Join-Path $SourceRoot 'connector\index.js') (Join-Path $InstallDir 'connector') -Force
Copy-Item (Join-Path $SourceRoot 'connector\config.example.json') (Join-Path $InstallDir 'connector') -Force
Copy-Item (Join-Path $SourceRoot 'app\core\*.js') (Join-Path $InstallDir 'app\core') -Force
foreach ($f in @('check.cmd', 'uninstall.cmd', 'uninstall.ps1')) {
  Copy-Item (Join-Path $PSScriptRoot $f) $InstallDir -Force
}
WriteText (Join-Path $InstallDir 'package.json') "{ `"private`": true, `"type`": `"module`" }`n"
Ok "Program files copied to $InstallDir"

# 6. Data folder, readable only by SYSTEM and Administrators (SIDs work on any Windows language)
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
& icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Could not set permissions on $DataDir" }

$cfgPath = Join-Path $DataDir 'config.json'
$cfg = $null
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  Ok "Keeping existing settings in $cfgPath"
}
if (-not $cfg) {
  $cfg = [ordered]@{
    tallyUrl = $TallyUrl; tallyCompany = ''; relayUrl = ''; keyFile = 'connector.key';
    intervalSec = $IntervalSec; tallyTimeoutSec = 60; conflictPolicy = 'tally-wins';
    writeCodesToTally = $true; logFile = 'connector.log'; logMaxMb = 5
  }
  $cfg = [pscustomobject]$cfg
}
if ($TallyCompany) { $cfg.tallyCompany = $TallyCompany }
if ($RelayUrl) { $cfg.relayUrl = $RelayUrl }
if ($PSBoundParameters.ContainsKey('TallyUrl')) { $cfg.tallyUrl = $TallyUrl }
while (-not $cfg.tallyCompany) { $cfg.tallyCompany = (Read-Host 'Company name exactly as shown in TallyPrime').Trim() }
while (-not ($cfg.relayUrl -match '^https?://')) { $cfg.relayUrl = (Read-Host 'App address, for example https://quickentry.pages.dev').Trim().TrimEnd('/') }
WriteText $cfgPath ($cfg | ConvertTo-Json)
Ok "Settings saved to $cfgPath"

# 7. Connector key (never on the command line, so it does not end up in history)
$keyPath = Join-Path $DataDir 'connector.key'
if ($NewKey -or -not (Test-Path $keyPath)) {
  $sec = Read-Host 'Paste the connector key (it will not be shown)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if (-not $plain) { Fail 'No key entered.' }
  WriteText $keyPath $plain
  $plain = $null
  Ok 'Connector key saved (readable only by SYSTEM and Administrators)'
} else {
  Ok 'Keeping the saved connector key (use -NewKey to replace it)'
}

# 8. Connection test
Say ''
& $node (Join-Path $InstallDir 'connector\index.js') --config $cfgPath --check
$checkOk = ($LASTEXITCODE -eq 0)
Say ''
if (-not $checkOk) { Warn 'The test above found a problem. The connector is installed anyway and keeps retrying; fix the item marked FAIL, then run check.cmd.' }

# 9. Scheduled task: SYSTEM, at startup, no time limit, re-checked every 5 minutes
$action = New-ScheduledTaskAction -Execute $node `
  -Argument ('"{0}" --config "{1}"' -f (Join-Path $InstallDir 'connector\index.js'), $cfgPath) `
  -WorkingDirectory $InstallDir
$atStartup = New-ScheduledTaskTrigger -AtStartup
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $watchdog) `
  -Principal $principal -Settings $settings -Description 'Sends QuickEntry app entries to TallyPrime and Tally masters to the app.' -Force | Out-Null
Ok "Scheduled task '$TaskName' registered (starts with Windows, runs without anyone signed in)"

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $state = (Get-ScheduledTask -TaskName $TaskName).State
  if ($state -eq 'Running') { Ok 'Connector is running' } else { Warn "Task state is $state. See $DataDir\connector.log" }
}

Say ''
Say 'Done.'
Say "  Log file:          $DataDir\connector.log"
Say "  Test connection:   $InstallDir\check.cmd"
Say "  Remove:            $InstallDir\uninstall.cmd"
Say ''
