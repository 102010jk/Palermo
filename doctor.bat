@echo off
rem Palermo: otestuje spojeni se serverem bez pouziti AI (nic nestoji). Server musi bezet.
cd /d "%~dp0"
set PALERMO_ADMIN_TOKEN=tajne
call npm run runner -- --check -c examples\sonnet4-haiku2.json
echo.
echo Zkusebni hra 5 botu pres stejny most jako Claude (nic nestoji):
call npm run runner -- -c examples\bots-bridge.json
pause
