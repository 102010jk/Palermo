@echo off
rem Palermo: stahne novou verzi z GitHubu (server musi byt vypnuty).
cd /d "%~dp0"
git pull
call npm install
call npm run build
echo Hotovo.
pause
