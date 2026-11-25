@echo off
title Stop DevSpace Ultra Agent
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-agent.ps1" %*
echo.
pause
