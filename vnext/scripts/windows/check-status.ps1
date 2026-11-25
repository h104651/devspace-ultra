param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [string]$LogFile = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-common.ps1')
$ctx = Get-ServiceContext $PSScriptRoot $DeviceId $ConfigDir
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($task) { Assert-ServiceTask $task $ctx; Write-Host "[TASK] $TaskName : $($task.State)" }
$st = Get-ServiceIpcStatus $ctx
if (-not $st -or -not $st.ok) {
    Write-Host '[NOT_VERIFIED] Target daemon unavailable. Inspect target log and lock before recovery.' -ForegroundColor Yellow
    exit 1
}
Assert-ServiceStatus $st $ctx -RequireWorker
Write-Host "[RUNNING] Device: $($st.deviceId) | Name: $($st.agentName) | Daemon: $($st.daemonPid) | Agent: $($st.agentPid) | Lock owner: $($st.lockOwnerPid)" -ForegroundColor Green
Write-Host "Log: $($st.logFile)"
exit 0
