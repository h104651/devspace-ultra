Write-Host "====================================================" -ForegroundColor Yellow
Write-Host "       Restarting DevSpace Ultra Local Agent...     " -ForegroundColor Yellow
Write-Host "====================================================" -ForegroundColor Yellow

Write-Host "`n[1/2] Stopping existing agent processes..." -ForegroundColor Cyan
& "C:\Users\testuser\Desktop\devspace-ultra\scripts\stop-agent.ps1"

Write-Host "`n[2/2] Launching background daemon..." -ForegroundColor Cyan
Start-Process "wscript.exe" -ArgumentList """C:\Users\testuser\Desktop\devspace-ultra\scripts\launch-daemon.vbs"""
Start-Sleep -Seconds 2

Write-Host "`n[3/3] Inspecting active processes..." -ForegroundColor Cyan
& "C:\Users\testuser\Desktop\devspace-ultra\scripts\check-status.ps1"
