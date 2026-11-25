param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$ReleaseDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [switch]$DirectVbs
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-common.ps1')
$ctx = Get-ServiceContext $PSScriptRoot $DeviceId $ConfigDir $ReleaseDir
$existing = Get-ServiceIpcStatus $ctx
if ($existing -and $existing.ok) { throw 'Target daemon already running.' }
if (-not $existing -or $existing.error -notlike 'CONTROL_NOT_FOUND:*') {
    throw 'Existing control state could not be verified absent. Inspect before starting.'
}
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) {
    Assert-ServiceTask $task $ctx
    if ($task.State -eq 'Running') { throw 'Target scheduled task is already running.' }
}
if ($task -and -not $DirectVbs) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
} else {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + $ctx.vbsPath + '"') -WorkingDirectory $ctx.launcherDir | Out-Null
}
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $st = Get-ServiceIpcStatus $ctx
    if ($st -and $st.ok) {
        try {
            Assert-ServiceStatus $st $ctx -RequireWorker
            Write-Host "[RUNNING] Device: $($st.deviceId) | Daemon PID: $($st.daemonPid) | Agent PID: $($st.agentPid) | Lock Owner Verified: True" -ForegroundColor Green
            exit 0
        } catch { if ($i -eq 29) { throw } }
    }
}
throw 'Target worker did not reach verified running state. Inspect its service log.'
