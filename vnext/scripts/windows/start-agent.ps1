param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$ReleaseDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [switch]$DirectVbs
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
if (-not $ReleaseDir) { $ReleaseDir = (Resolve-Path (Join-Path $scriptDir '..\..')).Path }
if (-not $ConfigDir) { $ConfigDir = $ReleaseDir }

function Resolve-NodeExe {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw 'node.exe not found.'
}

function Get-DeviceIdFromConfig([string]$CfgDir) {
    $envFile = Join-Path $CfgDir '.env'
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile) {
            if ($line -match '^\s*AGENT_ID\s*=\s*(.+)\s*$') {
                return $Matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }
    return ''
}

if (-not $DeviceId) { $DeviceId = Get-DeviceIdFromConfig $ConfigDir }
$nodeExe = Resolve-NodeExe
$ipcScript = Join-Path $scriptDir 'ipc-control.js'
$vbsPath = Join-Path $scriptDir 'launch-daemon.vbs'

Write-Host '====================================================' -ForegroundColor Green
Write-Host '    Starting DevSpace Ultra Agent (Background Mode) ' -ForegroundColor Green
Write-Host '====================================================' -ForegroundColor Green

# Check if already running via exact CommandLine + IPC status
$existingDaemon = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$($scriptDir)*agent-daemon.js*"
}
if ($existingDaemon) {
    Write-Host "  [WARN] Agent daemon already running (PID: $($existingDaemon.ProcessId -join ', ')). Aborting duplicate start." -ForegroundColor Yellow
    exit 1
}

if ($DeviceId) {
    $statusArgs = @($ipcScript, 'status', '--device-id', $DeviceId, '--json')
    $ipcCheck = & $nodeExe @statusArgs 2>$null
    if ($LASTEXITCODE -eq 0 -and $ipcCheck) {
        Write-Host "  [WARN] Device '$DeviceId' already has an active IPC-managed daemon. Aborting duplicate start." -ForegroundColor Yellow
        exit 1
    }
}

$startedByTask = $false
if (-not $DirectVbs) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') {
            Write-Host "  [WARN] Scheduled Task '$TaskName' is already Running." -ForegroundColor Yellow
            exit 1
        }
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "  [TASK] Started Windows Scheduled Task: $TaskName" -ForegroundColor Cyan
        $startedByTask = $true
    }
}

if (-not $startedByTask) {
    if (-not (Test-Path $vbsPath)) {
        throw "Missing launcher script: $vbsPath"
    }
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbsPath`"" -WorkingDirectory $ConfigDir | Out-Null
    Write-Host "  [DAEMON] Launched windowless daemon via: $vbsPath" -ForegroundColor Cyan
}

# Verify actual PID, CommandLine, and Lock Ownership (never by total Node.js count)
$verified = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $daemonProc = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent-daemon.js*'
    } | Select-Object -First 1
    $cliProc = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent-cli.js*'
    } | Select-Object -First 1

    if ($daemonProc -and $cliProc -and $DeviceId) {
        $statusJson = & $nodeExe $ipcScript status --device-id $DeviceId --json 2>$null
        if ($LASTEXITCODE -eq 0 -and $statusJson) {
            $st = $statusJson | ConvertFrom-Json
            if ($st.ok -and $st.lockExists -and ($st.lockOwnerPid -eq $cliProc.ProcessId)) {
                Write-Host "  [RUNNING] Daemon PID: $($st.daemonPid) | Agent PID: $($st.agentPid) | Lock Owner Verified: True" -ForegroundColor Green
                $verified = $true
                break
            }
        }
    } elseif ($daemonProc -and $cliProc -and -not $DeviceId) {
        Write-Host "  [RUNNING] Daemon PID: $($daemonProc.ProcessId) | Agent PID: $($cliProc.ProcessId)" -ForegroundColor Green
        $verified = $true
        break
    }
}

if (-not $verified) {
    Write-Host '  [ERROR] Agent did not reach verified running+locked state. Check logs\agent-daemon.log.' -ForegroundColor Red
    exit 1
}
