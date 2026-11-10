@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting the independent kitchen API at http://127.0.0.1:3000 ...
node --env-file-if-exists=.env server\src\main.mjs
pause
