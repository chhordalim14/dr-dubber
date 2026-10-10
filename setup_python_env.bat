@echo off
setlocal enabledelayedexpansion

REM ==============================================================================
REM   DR Dubber — Bundled TTS Python Environment Setup (Windows)
REM
REM   This creates backend\python_env — a lightweight, portable Python +
REM   edge-tts install that ships INSIDE the packaged app (unlike
REM   backend\spleeter-env, which is optional and excluded from packaging).
REM   Without this folder populated before running `npm run dist:win`, the
REM   installer ships with no working TTS engine at all, and every
REM   "Generate Selected Audio" click fails on a fresh user install.
REM
REM   Run this once before building a release. It downloads its own isolated
REM   Python — it does NOT need or touch any Python already on your system.
REM ==============================================================================

set "DIR=%~dp0"
cd /d "%DIR%"

echo.
echo ==========================================================
echo    [DR Dubber] Bundled TTS Python Environment Setup
echo ==========================================================
echo.

set "PYVER=3.11.9"
set "PYDIR=backend\python_env"
set "EMBED_ZIP=%TEMP%\dr-dubber-python-embed.zip"
set "GETPIP=%TEMP%\dr-dubber-get-pip.py"

if exist "%PYDIR%\python.exe" (
    "%PYDIR%\python.exe" -c "import edge_tts" >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        echo   [OK] %PYDIR% already exists and edge-tts is installed.
        call :textdetect
        call :bgmmodel
        echo   Delete the folder first if you want to rebuild it from scratch.
        goto :end
    )
)

echo [1/4] Downloading portable Python %PYVER% ^(embeddable, ~10MB^)...
if not exist "%PYDIR%" mkdir "%PYDIR%"
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-embed-amd64.zip' -OutFile '%EMBED_ZIP%' -UseBasicParsing } catch { exit 1 }"
if not exist "%EMBED_ZIP%" (
    echo   [X] Download failed. Check your internet connection and try again.
    pause
    exit /b 1
)
echo   [OK] Downloaded.

echo.
echo [2/4] Extracting into %PYDIR%...
powershell -NoProfile -Command "Expand-Archive -Path '%EMBED_ZIP%' -DestinationPath '%PYDIR%' -Force"
del /q "%EMBED_ZIP%" >nul 2>nul

REM Enable the `site` module so pip and site-packages actually load — the
REM embeddable distribution ships with this commented out by default.
for %%f in ("%PYDIR%\python3*._pth") do (
    powershell -NoProfile -Command "(Get-Content '%%f') -replace '^#import site$','import site' | Set-Content '%%f'"
)
echo   [OK] Extracted and configured.

echo.
echo [3/4] Bootstrapping pip...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile '%GETPIP%' -UseBasicParsing } catch { exit 1 }"
if not exist "%GETPIP%" (
    echo   [X] get-pip.py download failed.
    pause
    exit /b 1
)
"%PYDIR%\python.exe" "%GETPIP%" --no-warn-script-location
del /q "%GETPIP%" >nul 2>nul
echo   [OK] pip installed.

echo.
echo [4/4] Installing edge-tts...
"%PYDIR%\python.exe" -m pip install edge-tts --no-warn-script-location -q --disable-pip-version-check
if %ERRORLEVEL% neq 0 (
    echo   [!] Warning: edge-tts installation reported an issue.
) else (
    echo   [OK] edge-tts installed.
)

echo.
echo Verifying installation...
"%PYDIR%\python.exe" -c "import edge_tts" >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo   [OK] Bundled TTS environment verified and ready.
) else (
    echo   [X] Verification failed — edge_tts did not import correctly.
)
call :textdetect
call :bgmmodel
goto :end

REM Subtitle text detector ("Blur Subtitles"). --no-deps with every package pinned in the
REM requirements file: pip's own choices (numpy 2, protobuf 7) would break Spleeter/TensorFlow.
:textdetect
echo.
echo Installing the subtitle text detector (Blur Subtitles)...
"%PYDIR%\python.exe" -m pip install --no-deps -r backend\python\requirements-textdetect.txt --no-warn-script-location -q --disable-pip-version-check
"%PYDIR%\python.exe" -c "import rapidocr_onnxruntime, cv2, onnxruntime" >nul 2>nul
if !ERRORLEVEL! equ 0 (
    echo   [OK] Text detector installed.
) else (
    echo   [!] Text detector did not install - Blur Subtitles will try again when first used.
)
exit /b 0

REM Isolate BGM's built-in engine: UVR-MDX-NET-Voc_FT (~64MB), run by the
REM onnxruntime installed above. Shipped in the installer from backend\models.
:bgmmodel
set "MDXFILE=backend\models\UVR-MDX-NET-Voc_FT.onnx"
set "MDXURL=https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx"
set "MDXSHA=534B2070FCC7DF514B13EF660DC8CBB328679C2374D04354A5C42BB14ECCE111"
echo.
echo Getting the Isolate BGM model (MDX-Net Voc_FT, ~64MB)...
if not exist "backend\models" mkdir "backend\models"
if not exist "%MDXFILE%" (
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%MDXURL%' -OutFile '%MDXFILE%.part' -UseBasicParsing; Move-Item -Force '%MDXFILE%.part' '%MDXFILE%' } catch { exit 1 }"
)
powershell -NoProfile -Command "if ((Get-FileHash '%MDXFILE%' -Algorithm SHA256).Hash -eq '%MDXSHA%') { exit 0 } else { exit 1 }" >nul 2>nul
if !ERRORLEVEL! equ 0 (
    echo   [OK] Isolate BGM model ready.
) else (
    del /q "%MDXFILE%" >nul 2>nul
    echo   [X] The Isolate BGM model did not download correctly. Run this script again before building.
)
exit /b 0

:end
echo.
echo ==========================================================
echo    Done. You can now run: npm run dist:win
echo ==========================================================
echo.
pause
