@echo off
rem Palermo: otestuje spojeni se serverem bez pouziti AI (nic nestoji). Server musi bezet.
cd /d "%~dp0"
set PALERMO_ADMIN_TOKEN=tajne
call npm run runner -- --check -c examples\sonnet4-haiku2.json
pause
