param(
    [string]$LauncherDir = $PSScriptRoot,
    [string]$TaskName = 'DevSpaceUltra_LocalAgent',
    [int]$DelaySeconds = 10,
    [string]$UserId = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
)

$ErrorActionPreference = 'Stop'

$resolvedLauncherDir = (Resolve-Path $LauncherDir).Path
$vbsPath = Join-Path $resolvedLauncherDir 'launch-daemon.vbs'
if (-not (Test-Path $vbsPath)) {
    throw "launch-daemon.vbs not found in '$resolvedLauncherDir'"
}

Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '  Registering DevSpace Ultra Agent Scheduled Task   ' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan

$action = New-ScheduledTaskAction `
    -Execute 'C:\Windows\System32\wscript.exe' `
    -Argument "`"$vbsPath`"" `
    -WorkingDirectory $resolvedLauncherDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$trigger.Delay = "PT${DelaySeconds}S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

$principal = New-ScheduledTaskPrincipal `
    -UserId $UserId `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'DevSpace Ultra Local Outbound Agent Background Daemon (Least-Privilege)' `
    -Force | Out-Null

Write-Host "[SUCCESS] Scheduled Task registered: $TaskName" -ForegroundColor Green
Write-Host "  User      : $UserId (Interactive, Limited)" -ForegroundColor Gray
Write-Host "  Launcher  : $vbsPath" -ForegroundColor Gray
Write-Host "  Trigger   : At User Logon (+${DelaySeconds}s delay)" -ForegroundColor Gray
Write-Host '  Policy    : IgnoreNew, ExecutionTimeLimit=0, RestartOnFailure=3/1m (fail-closed exits return 0)' -ForegroundColor Gray
