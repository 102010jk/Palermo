@echo off
rem Palermo: spusti herni server a otevre web.
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist apps\web\dist call npm run build
set ADMIN_TOKEN=tajne
start "" http://127.0.0.1:3000
echo Admin heslo pro web (Game master login): tajne
call npm start
pause
