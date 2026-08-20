@echo off
REM ==============================================================================
REM  DR Dubber — Whisper Engine Runner (Windows)
REM ==============================================================================

set "DIR=%~dp0"

if exist "%DIR%venv\Scripts\python.exe" (
    "%DIR%venv\Scripts\python.exe" "%DIR%transcribe.py" %*
) else if exist "%DIR%..\backend\venv\Scripts\python.exe" (
    "%DIR%..\backend\venv\Scripts\python.exe" "%DIR%transcribe.py" %*
) else if exist "%DIR%..\.venv\Scripts\python.exe" (
    "%DIR%..\.venv\Scripts\python.exe" "%DIR%transcribe.py" %*
) else (
    python "%DIR%transcribe.py" %*
)
