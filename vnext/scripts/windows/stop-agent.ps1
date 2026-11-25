param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [int]$TimeoutMs = 10000,
    [switch]$ForceOnTimeout
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-common.ps1')
$ctx = Get-ServiceContext $PSScriptRoot $DeviceId $ConfigDir
$DeviceId = $ctx.deviceId
$ConfigDir = $ctx.configDir
$nodeExe = $ctx.nodeExe
$ipcScript = $ctx.ipcScript

Write-Host '====================================================' -ForegroundColor Yellow
Write-Host '    Stopping DevSpace Ultra Local Agent Gracefully  ' -ForegroundColor Yellow
Write-Host '====================================================' -ForegroundColor Yellow

# Never kill by wildcard command line or stop an unverified scheduled task.
# On IPC failure, require explicit operator reconciliation instead.
$ipcArgs = @($ipcScript, 'status', '--json')
if ($DeviceId) { $ipcArgs += @('--device-id', $DeviceId) }
elseif ($ConfigDir) { $ipcArgs += @('--config-dir', $ConfigDir) }
$beforeJson = & $nodeExe @ipcArgs 2>$null
if ($LASTEXITCODE -ne 0 -or -not $beforeJson) {
    Write-Host '[ABORT] Target daemon identity could not be verified. No processes stopped.' -ForegroundColor Red
    exit 1
}
$before = $beforeJson | ConvertFrom-Json
Assert-ServiceStatus $before $ctx
if (-not $before.ok -or -not $before.deviceId -or -not $before.daemonPid) { exit 1 }
if ($DeviceId -and $before.deviceId -ine $DeviceId) { exit 1 }
if ($ConfigDir -and [IO.Path]::GetFullPath($ConfigDir) -ine [IO.Path]::GetFullPath($before.configDir)) { exit 1 }
if ($before.agentPid -and (-not $before.lockExists -or $before.lockOwnerPid -ne $before.agentPid)) {
    Write-Host '[ABORT] Worker lock ownership is not verified.' -ForegroundColor Red
    exit 1
}
$ipcOutput = & $nodeExe $ipcScript shutdown --device-id $before.deviceId --timeout-ms "$TimeoutMs" --json 2>$null
$ipcExit = $LASTEXITCODE
$result = $null
try { $result = $ipcOutput | ConvertFrom-Json } catch {}
if ($ipcExit -ne 0 -or -not $result -or -not $result.ok -or
    $result.deviceId -ine $before.deviceId -or $result.daemonPid -ne $before.daemonPid -or
    -not $before.instanceId -or $result.instanceId -cne $before.instanceId -or
    -not $result.clean -or $result.exitCode -ne 0 -or $result.lockRetained) {
    Write-Host '[AUDIT_REQUIRED] Stop was not confirmed clean. No fallback kill or lock deletion performed.' -ForegroundColor Red
    if ($ForceOnTimeout) { Write-Host 'ForceOnTimeout is intentionally disabled until exact process-tree recovery is independently verified.' }
    exit 13
}
$targetPids = @($before.daemonPid, $before.agentPid) | Where-Object { $_ }
for ($i = 0; $i -lt 30; $i++) {
    $remaining = @($targetPids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
}
if ($remaining.Count -ne 0 -or (Test-Path -LiteralPath $before.lockPath)) {
    Write-Host '[AUDIT_REQUIRED] Target process or lock remains; no other process was stopped.' -ForegroundColor Red
    exit 13
}
Write-Host '[SUCCESS] Target daemon and worker exited with a clean IPC acknowledgement.' -ForegroundColor Green
exit 0
