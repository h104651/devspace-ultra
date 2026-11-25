param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [string]$LogFile = ''
)

$scriptDir = $PSScriptRoot
$ipcScript = Join-Path $scriptDir 'ipc-control.js'

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
    return $null
}

Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '       DevSpace Ultra Local Agent Status Check      ' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan

$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (
        ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*agent-daemon.js*' -or $_.CommandLine -like '*agent-cli.js*')) -or
        ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*launch-daemon.vbs*')
    )
}

if ($procs) {
    foreach ($p in $procs) {
        $role = if ($p.CommandLine -like '*launch-daemon.vbs*') {
            'Launcher Wrapper'
        } elseif ($p.CommandLine -like '*agent-daemon.js*') {
            'Daemon Supervisor'
        } else {
            'Agent Worker CLI'
        }
        Write-Host "  [RUNNING] $role (PID: $($p.ProcessId))" -ForegroundColor Green
        Write-Host "            CMD: $($p.CommandLine)" -ForegroundColor Gray
    }
} else {
    Write-Host '  [STOPPED] No agent launcher, daemon, or worker process found.' -ForegroundColor Red
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "  [AUTO-START] Enabled (Task '$TaskName': $($task.State))" -ForegroundColor Green
} else {
    Write-Host "  [AUTO-START] Disabled (Task '$TaskName' not registered)" -ForegroundColor Yellow
}

$nodeExe = Resolve-NodeExe
$resolvedLog = $LogFile
if ($nodeExe -and (Test-Path $ipcScript)) {
    $ipcArgs = @($ipcScript, 'status', '--json')
    if ($DeviceId) { $ipcArgs += @('--device-id', $DeviceId) }
    elseif ($ConfigDir) { $ipcArgs += @('--config-dir', $ConfigDir) }
    $ipcJson = & $nodeExe @ipcArgs 2>$null
    if ($LASTEXITCODE -eq 0 -and $ipcJson) {
        $st = $ipcJson | ConvertFrom-Json
        if ($st.ok) {
            Write-Host "  [IPC] Device: $($st.deviceId) | Name: $($st.agentName) | DaemonPID: $($st.daemonPid) | AgentPID: $($st.agentPid)" -ForegroundColor Cyan
            Write-Host "  [LOCK] Path: $($st.lockPath) | Exists: $($st.lockExists) | OwnerPID: $($st.lockOwnerPid)" -ForegroundColor Cyan
            if (-not $resolvedLog -and $st.logFile) { $resolvedLog = $st.logFile }
        }
    }
}

$lockDir = Join-Path $env:USERPROFILE '.devspace-ultra\agent-locks'
if (Test-Path $lockDir) {
    $lockFiles = Get-ChildItem $lockDir -Filter '*.lock' -ErrorAction SilentlyContinue
    if ($lockFiles) {
        Write-Host "`nActive/Residual Lock Files:" -ForegroundColor Cyan
        foreach ($lf in $lockFiles) {
            $owner = Get-Content $lf.FullName -Raw -ErrorAction SilentlyContinue
            Write-Host "  $($lf.Name): $owner" -ForegroundColor Gray
        }
    }
}

if (-not $resolvedLog) {
    $fallbackBase = if ($ConfigDir) { $ConfigDir } else { (Resolve-Path (Join-Path $scriptDir '..\..')).Path }
    $resolvedLog = Join-Path $fallbackBase 'logs\agent-daemon.log'
}
if ($resolvedLog -and (Test-Path $resolvedLog)) {
    Write-Host "`nRecent Daemon Logs ($resolvedLog):" -ForegroundColor Cyan
    Get-Content $resolvedLog -Tail 8 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}
