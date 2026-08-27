@echo off
title DevSpace Ultra - Local Agent
color 0B
echo ====================================================
echo       DevSpace Ultra - Local Outbound Agent        
echo ====================================================
echo Starting Local Agent connected to Cloudflare Gateway...
echo.
cd /d "C:\Users\testuser\AppData\Local\devspace-ultra-src\vnext"
node dist\cli\agent-cli.js
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Agent stopped or encountered an error.
    pause
)
