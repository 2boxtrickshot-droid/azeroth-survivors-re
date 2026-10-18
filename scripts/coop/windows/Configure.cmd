@echo off
cd /d "%~dp0"
"runtime\node.exe" "scripts\coop\windows.mjs" --configure
pause
