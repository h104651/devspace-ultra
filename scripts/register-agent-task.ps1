# DevSpace Ultra Local Agent - Windows Task Scheduler Auto-Start Registration
# Replaces legacy Startup folder with robust, network-delayed, restart-protected Task Scheduler service

$ErrorActionPreference = 'Stop'

Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '  Registering DevSpace Ultra Agent Scheduled Task   ' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan

# 1. Clean up legacy Startup folder shortcut if present
$startupDir = [Environment]::GetFolderPath('Startup')
$legacyVbs = Join-Path $startupDir 'DevSpaceUltraAgent.vbs'
if (Test-Path $legacyVbs) {
    Remove-Item $legacyVbs -Force
    Write-Host '[CLEANUP] Removed legacy Startup folder script: DevSpaceUltraAgent.vbs' -ForegroundColor Yellow
}

# 2. Define Scheduled Task Action: directly execute node.exe with agent-daemon.js
$action = New-ScheduledTaskAction `
    -Execute 'C:\Program Files\nodejs\node.exe' `
    -Argument 'C:\Users\testuser\Desktop\devspace-ultra\scripts\agent-daemon.js' `
    -WorkingDirectory 'C:\Users\testuser\Desktop\devspace-ultra'

# 3. Define Trigger: At Logon + 10s delay for network readiness
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT10S'

# 4. Define Settings: battery-safe, start-when-available, max 3 restarts on failure
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

# 5. Register Task
$taskName = 'DevSpaceUltra_LocalAgent'
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'DevSpace Ultra Local Outbound Agent Background Daemon' `
    -Force | Out-Null

Write-Host '[SUCCESS] Windows Scheduled Task registered successfully: ' -NoNewline -ForegroundColor Green
Write-Host $taskName -ForegroundColor White
Write-Host '  Trigger   : At User Logon (10s network readiness delay)' -ForegroundColor Gray
Write-Host '  Guard     : Max 3 automatic restarts on failure, zero CPU burn' -ForegroundColor Gray
Write-Host '  Mode      : Background Daemon (node.exe via Task Scheduler, windowless)' -ForegroundColor Gray
Write-Host ''
