@echo off
rem Windows launcher for erfMap: the same steps as "Start erfMap.command" on macOS.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Install Node.js 20 or later from https://nodejs.org, then open this launcher again.
    pause
    exit /b 1
)

if not defined ERFMAP_PYTHON (
    set "python_cmd="
    for %%c in ("py -3" python python3) do (
        if not defined python_cmd (
            %%~c -c "import sys; raise SystemExit(sys.version_info < (3, 10))" >nul 2>nul && set "python_cmd=%%~c"
        )
    )
    call :prepare_python || (pause & exit /b 1)
)

where ffmpeg >nul 2>nul || echo Note: FFmpeg is not on PATH, so video uploads will not process. Photos still work.

if not defined PORT set PORT=3000
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"
node server.js
pause
exit /b

:prepare_python
if not defined python_cmd (
    echo Install Python 3.10 or later from https://python.org to prepare image processing support.
    exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
    echo Creating the erfMap Python environment...
    %python_cmd% -m venv .venv || (echo Could not create .venv. & exit /b 1)
)
set "stamp=.venv\.erfmap-requirements.txt"
fc /b worker\requirements.txt "%stamp%" >nul 2>nul
if errorlevel 1 goto install
".venv\Scripts\python.exe" -c "import cv2, numpy" >nul 2>nul
if errorlevel 1 goto install
goto ready
:install
echo Preparing image processing dependencies...
".venv\Scripts\python.exe" -m pip install -r worker\requirements.txt || (echo Dependency setup failed. Check the network, then retry. & exit /b 1)
copy /y worker\requirements.txt "%stamp%" >nul
:ready
set "ERFMAP_PYTHON=%CD%\.venv\Scripts\python.exe"
exit /b 0
