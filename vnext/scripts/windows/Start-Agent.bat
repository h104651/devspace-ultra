@echo off
title Start DevSpace Ultra Agent
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-agent.ps1" %*
echo.
pause
