@echo off
title Start DevSpace Ultra Agent
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\start-agent.ps1" %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Agent failed to start. Check logs for details.
    pause
)
