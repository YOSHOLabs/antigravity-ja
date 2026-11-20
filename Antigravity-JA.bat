@echo off
setlocal
start "" wscript.exe //B //Nologo "%~dp0bin\app-silent.vbs"
exit /b 0
