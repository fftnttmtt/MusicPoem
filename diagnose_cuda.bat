@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" goto missing_env
".venv\Scripts\python.exe" repair_cuda.py --check
set "SPECTRA_EXIT=%ERRORLEVEL%"
pause
exit /b %SPECTRA_EXIT%
:missing_env
echo Run install_cpu.bat or install_gpu.bat first.
pause
exit /b 1
