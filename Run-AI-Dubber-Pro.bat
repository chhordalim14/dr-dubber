@echo off
title AI Dubber Pro Desktop Studio
cd /d "%~dp0"
echo =======================================================
echo          DAI Dubber Pro - AI Studio Launcher
echo =======================================================
echo.
echo Starting AI Dubber Pro Desktop Application...
echo.
npm.cmd start
if %errorlevel% neq 0 (
    echo.
    echo [Fallback] Launching Studio in Browser Mode...
    start http://localhost:5890
    node backend/server.js
)
pause
