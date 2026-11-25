param(
    [string]$TaskName = 'DevSpaceUltra_LocalAgent'
)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host '====================================================' -ForegroundColor Yellow
Write-Host ' Unregistering DevSpace Ultra Agent Scheduled Task  ' -ForegroundColor Yellow
Write-Host '====================================================' -ForegroundColor Yellow

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[SUCCESS] Removed scheduled task: $TaskName" -ForegroundColor Green
