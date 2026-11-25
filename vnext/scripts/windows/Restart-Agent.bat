@echo off
title Restart DevSpace Ultra Agent
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-agent.ps1" %*
echo.
pause
