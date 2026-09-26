@echo off
rem Palermo: AI hraci cekaji na lobby. Nejdriv musi bezet start-server.bat.
rem Hrace vybiras na webu na strance "AI players" (http://localhost:3000/players).
rem Jakmile na webu zalozis lobby s volnymi misty, vybrani hraci se do nej sami pripoji.
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
if "%CFG%"=="" set CFG=examples\pool.json
rem Otevre stranku, kde vybiras hrace (musi byt spusteny start-server.bat).
start "" http://localhost:3000/players
call npm run runner -- --pool -c %CFG%
pause
