# DevSpace Ultra Local Agent - Windows Task Scheduler Unregistration
$ErrorActionPreference = 'SilentlyContinue'

Write-Host '====================================================' -ForegroundColor Yellow
Write-Host ' Unregistering DevSpace Ultra Agent Scheduled Task  ' -ForegroundColor Yellow
Write-Host '====================================================' -ForegroundColor Yellow

$taskName = 'DevSpaceUltra_LocalAgent'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$startupDir = [Environment]::GetFolderPath('Startup')
$legacyVbs = Join-Path $startupDir 'DevSpaceUltraAgent.vbs'
if (Test-Path $legacyVbs) {
    Remove-Item $legacyVbs -Force
}

Write-Host "[SUCCESS] Disabled auto-start for $taskName" -ForegroundColor Green
