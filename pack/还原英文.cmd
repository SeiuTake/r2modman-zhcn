@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%tools\r2modman-zhcn.ps1" -Action Restore  %*
echo.
pause