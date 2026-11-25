param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [int]$TimeoutMs = 10000,
    [switch]$ForceOnTimeout
)

$ErrorActionPreference = 'Stop'
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
    throw 'node.exe not found.'
}

$nodeExe = Resolve-NodeExe

Write-Host '====================================================' -ForegroundColor Yellow
Write-Host '    Stopping DevSpace Ultra Local Agent Gracefully  ' -ForegroundColor Yellow
Write-Host '====================================================' -ForegroundColor Yellow

$ipcArgs = @($ipcScript, 'shutdown', '--timeout-ms', "$TimeoutMs", '--json')
if ($DeviceId) { $ipcArgs += @('--device-id', $DeviceId) }
elseif ($ConfigDir) { $ipcArgs += @('--config-dir', $ConfigDir) }

$ipcOutput = & $nodeExe @ipcArgs 2>$null
$ipcExit = $LASTEXITCODE
$ipcParsed = $null
if ($ipcOutput) {
    try { $ipcParsed = $ipcOutput | ConvertFrom-Json } catch {}
}

if ($ipcExit -eq 0 -and $ipcParsed -and $ipcParsed.ok) {
    Write-Host "  [IPC] Daemon acknowledged shutdown (exitCode=$($ipcParsed.exitCode), reason=$($ipcParsed.exitReason), clean=$($ipcParsed.clean), lockRetained=$($ipcParsed.lockRetained))." -ForegroundColor Cyan
    if ($ipcParsed.lockRetained) {
        Write-Host '  [AUDIT_REQUIRED] Agent stopped with in-flight tasks/mutation timeout; lock file intentionally preserved for manual audit.' -ForegroundColor Red
        exit 13
    }
} else {
    Write-Host "  [WARN] Authenticated IPC shutdown did not complete cleanly ($($ipcParsed.error))." -ForegroundColor Yellow
    if (-not $ForceOnTimeout) {
        Write-Host '  [ABORT] Refusing blind Stop-Process -Force without -ForceOnTimeout. Inspect status/logs or re-run with -ForceOnTimeout if daemon is hung.' -ForegroundColor Red
        exit 1
    }

    Write-Host '  [FORCE] Stopping Task Scheduler + Daemon/Launcher first, then Worker...' -ForegroundColor Red
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300

    $daemons = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and (
            ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent-daemon.js*') -or
            ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*launch-daemon.vbs*')
        )
    }
    foreach ($d in $daemons) {
        Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  [STOPPED] Daemon/Launcher PID $($d.ProcessId)" -ForegroundColor Yellow
    }

    $workers = Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent-cli.js*'
    }
    foreach ($w in $workers) {
        Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  [STOPPED] Worker PID $($w.ProcessId)" -ForegroundColor Yellow
    }
    Write-Host '  [NOTICE] Residual .lock files are NOT deleted automatically. Verify process exit and reconcile tasks before manual lock removal.' -ForegroundColor Yellow
}

# Wait briefly for wscript / Task Scheduler wrapper to settle
Start-Sleep -Milliseconds 800
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$remaining = Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (
        ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*agent-daemon.js*' -or $_.CommandLine -like '*agent-cli.js*')) -or
        ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*launch-daemon.vbs*')
    )
}
if ($remaining) {
    Write-Host '  [ERROR] Residual agent processes still running:' -ForegroundColor Red
    $remaining | ForEach-Object { Write-Host "    PID $($_.ProcessId): $($_.CommandLine)" -ForegroundColor Gray }
    exit 1
}

Write-Host '  [SUCCESS] Agent stopped cleanly with zero residual processes.' -ForegroundColor Green
