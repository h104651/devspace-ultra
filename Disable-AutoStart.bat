@echo off
title Disable DevSpace Ultra Auto-Start
color 0C
echo ====================================================
echo   Disable DevSpace Ultra Agent Windows Auto-Start   
echo ====================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\testuser\Desktop\devspace-ultra\scripts\unregister-agent-task.ps1"

echo.
pause
