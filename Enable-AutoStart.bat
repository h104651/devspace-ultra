@echo off
title Enable DevSpace Ultra Auto-Start
color 0A
echo ====================================================
echo    Enable DevSpace Ultra Agent Windows Auto-Start   
echo ====================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\testuser\Desktop\devspace-ultra\scripts\register-agent-task.ps1"

echo.
echo The Agent will now start automatically whenever you log into Windows.
echo.
pause
