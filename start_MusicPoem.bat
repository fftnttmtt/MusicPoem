@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto bad_folder
set "SPECTRA_PY=%~dp0.venv\Scripts\python.exe"
if not exist "%SPECTRA_PY%" goto missing_env
if not exist "%~dp0spectra_server.py" goto missing_server
echo MusicPoem LAB R56
echo Starting with the project virtual environment...
"%SPECTRA_PY%" "%~dp0spectra_server.py" --lab %*
set "SPECTRA_EXIT=%ERRORLEVEL%"
if not "%SPECTRA_EXIT%"=="0" echo Server exited with an error. See the message above.
pause
exit /b %SPECTRA_EXIT%
:missing_env
echo Missing .venv\Scripts\python.exe in this project folder.
echo Run install_gpu.bat or install_cpu.bat first.
pause
exit /b 1
:missing_server
echo Missing spectra_server.py. Extract the complete project ZIP first.
pause
exit /b 1
:bad_folder
echo Cannot enter the project folder.
pause
exit /b 1
