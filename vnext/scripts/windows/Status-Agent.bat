@echo off
title DevSpace Ultra Agent Status
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-status.ps1" %*
echo.
pause
