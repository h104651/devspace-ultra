$procs = Get-CimInstance Win32_Process | Where-Object { 
    $_.CommandLine -like '*agent-daemon.js*' -or $_.CommandLine -like '*agent-cli.js*' 
}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "       DevSpace Ultra Local Agent Status Check       " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

if ($procs) {
    foreach ($p in $procs) {
        $type = if ($p.CommandLine -like '*agent-daemon.js*') { "Daemon Supervisor" } else { "Agent Worker CLI" }
        Write-Host "  [RUNNING] $type (PID: $($p.ProcessId))" -ForegroundColor Green
    }
} else {
    Write-Host "  [STOPPED] No agent daemon or worker process found." -ForegroundColor Red
}

$task = Get-ScheduledTask -TaskName 'DevSpaceUltra_LocalAgent' -ErrorAction SilentlyContinue
$startup = [Environment]::GetFolderPath('Startup')
$target = Join-Path $startup 'DevSpaceUltraAgent.vbs'
if ($task) {
    Write-Host "  [AUTO-START] Enabled (Windows Task Scheduler: $($task.State))" -ForegroundColor Green
} elseif (Test-Path $target) {
    Write-Host "  [AUTO-START] Enabled (Legacy Windows Startup)" -ForegroundColor Green
} else {
    Write-Host "  [AUTO-START] Disabled" -ForegroundColor Yellow
}

$logPath = 'C:\Users\testuser\Desktop\devspace-ultra\logs\agent-daemon.log'
if (Test-Path $logPath) {
    Write-Host "`nRecent Daemon Logs:" -ForegroundColor Cyan
    Get-Content $logPath -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
}
