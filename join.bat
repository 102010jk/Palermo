@echo off
rem Palermo: posadi AI hrace do hry, kterou jsi zalozil na webu.
rem Pouziti: join.bat               (zepta se na id hry, hraci z examples\sonnet4-haiku2.json)
rem          join.bat g_abc123 examples\jiny-config.json
cd /d "%~dp0"
if exist .claude-token goto have_token
echo Jeste nemas ulozeny Claude token. V jinem okne spust: claude setup-token
set /p NEWTOKEN=Token: 
> .claude-token echo %NEWTOKEN%
:have_token
set /p CLAUDE_CODE_OAUTH_TOKEN=<.claude-token
set PALERMO_ADMIN_TOKEN=tajne
set GAME=%~1
if "%GAME%"=="" set /p GAME=Id hry (z adresy /game/...): 
set CFG=%~2
if "%CFG%"=="" set CFG=examples\sonnet4-haiku2.json
call npm run runner -- -c %CFG% --game %GAME%
pause
