@echo off
title Stop DevSpace Ultra Agent
color 0C
echo ====================================================
echo       Stopping DevSpace Ultra Local Agent...       
echo ====================================================
echo.
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*agent-cli*' }; if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('[SUCCESS] Terminated Agent Process (PID: ' + $_.ProcessId + ')') -ForegroundColor Green } } else { Write-Host '[INFO] No running DevSpace Agent process found.' -ForegroundColor Yellow }"
echo.
echo Operation complete.
ping 127.0.0.1 -n 3 >nul
