@echo off
setlocal enabledelayedexpansion

REM ==============================================================================
REM   DR Dubber — Local Whisper Engine Setup (Windows)
REM ==============================================================================

set "DIR=%~dp0"
cd /d "%DIR%"

echo.
echo ==========================================================
echo    [DR Dubber] Local Whisper Engine Setup (Windows)
echo ==========================================================
echo.

REM Step 1: Detect Python
echo [1/4] Detecting Python environment...

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
    echo  Please install Python 3 (3.9 - 3.12 recommended) from:
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
echo [2/4] Setting up isolated virtual environment...
if not exist "venv\Scripts\activate.bat" (
    echo   - Creating virtualenv in .\venv...
    %PY% -m venv venv
    if %ERRORLEVEL% neq 0 (
        echo   [X] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo   [OK] Virtual environment created.
) else (
    echo   [OK] Virtual environment already exists.
)

REM Step 3: Install dependencies
echo.
echo [3/4] Installing speech-to-text dependencies...
call "venv\Scripts\activate.bat"

echo   - Upgrading pip and wheel...
python -m pip install --upgrade pip wheel -q --disable-pip-version-check

echo   - Installing faster-whisper...
python -m pip install -r requirements.txt -q --disable-pip-version-check
if %ERRORLEVEL% neq 0 (
    echo   [!] Warning: Dependency installation reported an issue.
) else (
    echo   [OK] Dependencies installed successfully.
)

REM Step 4: Verification
echo.
echo [4/4] Verifying installation...
python -c "import faster_whisper; print('  [OK] faster-whisper verified successfully.')" 2>nul
if %ERRORLEVEL% neq 0 (
    python -c "import whisper; print('  [OK] openai-whisper verified successfully.')" 2>nul
)

echo.
echo ==========================================================
echo    [OK] Setup Complete & Ready to Use!
echo ==========================================================
echo  Whisper Folder Path for DR Dubber Settings:
echo    %DIR:~0,-1%
echo.
echo  Tip: Set this folder path under DR Dubber -^> Settings -^> Whisper Folder Path.
echo ==========================================================
echo.
pause
