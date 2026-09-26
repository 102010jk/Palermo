@echo off
rem Palermo: dohraje rozehranou hru (po vycerpanem limitu, zavrenem okne nebo restartu PC).
rem Pouziti: resume.bat              (posledni nedohrana hra s AI hraci)
rem          resume.bat g_abc123     (konkretni hra)
rem Hry spustene pres agents.bat (stranka AI players) se po spusteni agents.bat vrati samy.
cd /d "%~dp0"
if exist .claude-token goto have_token
echo Jeste nemas ulozeny Claude token. V jinem okne spust: claude setup-token
set /p NEWTOKEN=Token: 
> .claude-token echo %NEWTOKEN%
:have_token
set /p CLAUDE_CODE_OAUTH_TOKEN=<.claude-token
set PALERMO_ADMIN_TOKEN=tajne
set GAME=%~1
if "%GAME%"=="" set GAME=latest
call npm run runner -- --resume %GAME% -c examples\pool.json
pause
