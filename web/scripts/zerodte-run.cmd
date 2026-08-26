@echo off
setlocal enabledelayedexpansion
REM ==========================================================================
REM  Wrapper del tick de la cuenta de paper del 0DTE.
REM    zerodte-run.cmd [TICKER]   (por defecto SPY)
REM
REM  Igual que el de venta de prima, NECESITA el servidor de Tito levantado:
REM  la logica vive en una ruta de la app. Si el puerto 3000 no responde, lo
REM  arranca y espera. La diferencia es que esto corre CADA MINUTO, asi que la
REM  espera es corta: si Tito no esta listo en ~30 s, se deja para el minuto
REM  siguiente en vez de encadenar arranques.
REM ==========================================================================
set "PATH=C:\Program Files\nodejs;%PATH%"
set "WEBDIR=%~dp0.."
cd /d "%WEBDIR%"

set "TICKER=%~1"
if "%TICKER%"=="" set "TICKER=SPY"

curl -s -o nul http://127.0.0.1:3000
if not errorlevel 1 goto run

start "Tito Metralleta - Servidor (NO CERRAR)" /min "%WEBDIR%\start-dev.cmd"
set /a tries=0
:waitloop
timeout /t 3 /nobreak >nul
curl -s -o nul http://127.0.0.1:3000
if not errorlevel 1 goto run
set /a tries+=1
if !tries! lss 10 goto waitloop
exit /b 0

:run
node "scripts\zerodte-run.mjs" %TICKER%
exit /b %errorlevel%
