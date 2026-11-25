@echo off
title Disable DevSpace Ultra Auto-Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0unregister-agent-task.ps1" %*
echo.
pause
