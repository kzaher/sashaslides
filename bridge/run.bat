@echo off
REM Self-contained launcher for the Sasha Slides bridge (Windows).
REM Creates a LOCAL .venv next to this script, installs deps into it, and serves.
REM Nothing is installed globally.
setlocal
set "HERE=%~dp0"
set "VENV=%SASHA_VENV%"
if "%VENV%"=="" set "VENV=%HERE%.venv"

if not exist "%VENV%\Scripts\python.exe" (
  echo ==^> creating venv at %VENV%
  python -m venv "%VENV%" || (echo Could not create venv. Install Python 3.9+ from python.org & exit /b 1)
)
set "VPY=%VENV%\Scripts\python.exe"

"%VPY%" -c "import aiohttp, aiortc, qrcode" 1>nul 2>nul
if errorlevel 1 (
  echo ==^> installing dependencies into the venv ^(nothing global is changed^)
  "%VPY%" -m pip install --quiet --upgrade pip
  "%VPY%" -m pip install --quiet -r "%HERE%requirements.txt"
)

echo ==^> starting the bridge - open http://localhost:8787/ to pair
"%VPY%" "%HERE%wrapper.py" serve %*
