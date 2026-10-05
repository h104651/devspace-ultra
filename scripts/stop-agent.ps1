$procs = Get-CimInstance Win32_Process | Where-Object { 
    $_.CommandLine -like '*agent-daemon.js*' -or $_.CommandLine -like '*agent-cli.js*' 
}

Write-Host "====================================================" -ForegroundColor Red
Write-Host "       Stopping DevSpace Ultra Local Agent...       " -ForegroundColor Red
Write-Host "====================================================" -ForegroundColor Red

if ($procs) {
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.ProcessId -Force
            Write-Host "  [STOPPED] Terminated PID $($p.ProcessId) ($($p.Name))" -ForegroundColor Green
        } catch {
            Write-Host "  [ERROR] Failed to stop PID $($p.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "  [INFO] No running DevSpace Agent processes found." -ForegroundColor Yellow
}
