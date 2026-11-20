@echo off
setlocal
start "" wscript.exe //B //Nologo "%~dp0bin\launch-silent.vbs" %*
exit /b 0
