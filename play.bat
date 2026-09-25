@echo off
rem Palermo: spusti hru AI hracu. Nejdriv musi bezet start-server.bat.
rem Pouziti: play.bat            (4x Sonnet + 2x Haiku)
rem          play.bat examples\jiny-config.json
cd /d "%~dp0"
if exist .claude-token goto have_token
echo.
echo Jeste nemas ulozeny Claude token.
echo V jinem okne spust:  claude setup-token
echo a token sem vloz (ulozi se jen do souboru .claude-token na tomto PC):
set /p NEWTOKEN=Token: 
> .claude-token echo %NEWTOKEN%
:have_token
set /p CLAUDE_CODE_OAUTH_TOKEN=<.claude-token
set PALERMO_ADMIN_TOKEN=tajne
set CFG=%~1
if "%CFG%"=="" set CFG=examples\sonnet4-haiku2.json
call npm run runner -- -c %CFG%
pause
