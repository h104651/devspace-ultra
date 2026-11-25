param(
    [string]$DeviceId = '',
    [string]$ConfigDir = '',
    [string]$ReleaseDir = '',
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [int]$TimeoutMs = 10000
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot

Write-Host '====================================================' -ForegroundColor Yellow
Write-Host '       Restarting DevSpace Ultra Local Agent...     ' -ForegroundColor Yellow
Write-Host '====================================================' -ForegroundColor Yellow

$stopParams = @{ TaskName = $TaskName; TimeoutMs = $TimeoutMs }
if ($DeviceId) { $stopParams.DeviceId = $DeviceId }
if ($ConfigDir) { $stopParams.ConfigDir = $ConfigDir }
& (Join-Path $scriptDir 'stop-agent.ps1') @stopParams
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ABORT] Graceful stop exited with code $LASTEXITCODE. Skipping start to preserve lock/mutation safety." -ForegroundColor Red
    exit $LASTEXITCODE
}

Start-Sleep -Seconds 1
$startParams = @{ TaskName = $TaskName }
if ($DeviceId) { $startParams.DeviceId = $DeviceId }
if ($ConfigDir) { $startParams.ConfigDir = $ConfigDir }
if ($ReleaseDir) { $startParams.ReleaseDir = $ReleaseDir }
& (Join-Path $scriptDir 'start-agent.ps1') @startParams
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $scriptDir 'check-status.ps1') -DeviceId $DeviceId -ConfigDir $ConfigDir -TaskName $TaskName
