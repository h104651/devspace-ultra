param([string]$TaskName = 'DevSpaceUltra_LocalAgent')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'service-common.ps1')
$ctx = Get-ServiceContext $PSScriptRoot
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $task) { Write-Host 'Target task is not registered.'; exit 0 }
Assert-ServiceTask $task $ctx
if ($task.State -eq 'Running') { throw 'Stop the target service through authenticated IPC before unregistering.' }
Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
Write-Host "[SUCCESS] Removed verified task: $TaskName"
