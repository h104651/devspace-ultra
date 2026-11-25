@echo off
title Enable DevSpace Ultra Auto-Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-agent-task.ps1" %*
echo.
pause
