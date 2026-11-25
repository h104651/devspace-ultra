@echo off
title Stop DevSpace Ultra Agent
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\stop-agent.ps1" %*
echo.
pause
