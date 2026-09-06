@echo off
setlocal enabledelayedexpansion

REM ==============================================================================
REM   DR Dubber — Offline Spleeter AI Stem Separator Setup (Windows)
REM ==============================================================================

set "DIR=%~dp0"
cd /d "%DIR%"

echo.
echo ==========================================================
echo    [DR Dubber] Spleeter AI Stem Separator Setup
echo ==========================================================
echo.

REM Step 1: Detect Python
echo [1/3] Detecting Python environment...

set "PY="
where py >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "PY=py -3"
) else (
    where python >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        set "PY=python"
    )
)

if "%PY%"=="" (
    echo.
    echo  [X] Error: Python 3 was not found on your system.
    echo  Please install Python 3.9, 3.10, or 3.11 from:
    echo    https://www.python.org/downloads/
    echo  (Make sure to check "Add Python to PATH" during installation)
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('%PY% --version 2^>^&1') do set "PY_VER=%%v"
echo   [OK] Found %PY_VER% (%PY%)

REM Step 2: Create virtual environment
echo.
echo [2/3] Setting up local Spleeter environment...
if not exist "backend\spleeter-env\Scripts\activate.bat" (
    echo   - Creating virtual environment in .\backend\spleeter-env...
    %PY% -m venv "backend\spleeter-env"
    if %ERRORLEVEL% neq 0 (
        echo   [X] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo   [OK] Environment created.
) else (
    echo   [OK] Environment already exists.
)

REM Step 3: Install Spleeter & dependencies
echo.
echo [3/3] Installing Spleeter and neural network dependencies...
call "backend\spleeter-env\Scripts\activate.bat"

echo   - Upgrading pip and wheel...
python -m pip install --upgrade pip wheel -q --disable-pip-version-check

echo   - Installing Spleeter (this may take a few minutes)...
python -m pip install spleeter -q --disable-pip-version-check
if %ERRORLEVEL% neq 0 (
    echo   [!] Warning: Installation reported an issue.
) else (
    echo   [OK] Spleeter installed successfully.
)

REM Step 4: Verification
echo.
echo Verifying installation...
python -m spleeter --help >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo   [OK] Spleeter engine verified and ready for AI vocal/BGM separation!
) else (
    echo   [!] Notice: Note that DR Dubber also includes built-in instant FFmpeg phase cancellation as a zero-setup fallback.
)

echo.
echo ==========================================================
echo    [OK] Setup Complete! DR Dubber is ready to isolate BGM.
echo ==========================================================
echo.
pause
