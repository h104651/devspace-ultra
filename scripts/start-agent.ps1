Write-Host "====================================================" -ForegroundColor Green
Write-Host "    Starting DevSpace Ultra Agent (Background Mode) " -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Green
Write-Host ""

$started = $false
try {
    $schResult = cmd.exe /c "schtasks /run /tn DevSpaceUltra_LocalAgent 2>&1"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [TASK] Triggered Windows Scheduled Task: DevSpaceUltra_LocalAgent" -ForegroundColor Cyan
        $started = $true
    }
} catch {
    # fallback to wscript
}

if (-not $started) {
    Write-Host "  [DAEMON] Launching agent daemon via WScript background process..." -ForegroundColor Cyan
    Start-Process "wscript.exe" -ArgumentList "C:\Users\testuser\Desktop\devspace-ultra\scripts\launch-daemon.vbs"
}

Start-Sleep -Seconds 2

# Verify process via fast Get-Process
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($nodeProcs.Count -ge 2) {
    Write-Host "  [SUCCESS] Local Agent is active and running in background." -ForegroundColor Green
} else {
    Write-Host "  [INFO] Agent process initialized. Check logs if needed." -ForegroundColor Yellow
}

Write-Host "  [GATEWAY] Target: wss://devspace-ultra-gateway.abdul-hsu.workers.dev/ws/agent" -ForegroundColor Gray
Write-Host ""
