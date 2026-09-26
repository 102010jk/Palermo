@echo off
rem Palermo: stahne novou verzi z GitHubu (server musi byt vypnuty).
cd /d "%~dp0"
rem Mistni zmeny v souborech z GitHubu by zablokovaly stazeni: odlozime je (git stash list / git stash show -p).
git diff --quiet
if errorlevel 1 (
  echo Mistni zmeny odkladam do git stash, aby slo stahnout novou verzi.
  git stash push -m "palermo update.bat %date% %time%"
)
git pull
if errorlevel 1 (
  echo.
  echo Stazeni selhalo, nic dalsiho nedelam. Posli tento vypis.
  pause
  exit /b 1
)
call npm install
call npm run build
echo Hotovo.
pause
