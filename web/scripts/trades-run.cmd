@echo off
setlocal enabledelayedexpansion
REM ==========================================================================
REM  Wrapper del refresco de la BITACORA (pestanas Todos/Swing de Mis Trades).
REM
REM  Igual que los de venta de prima y 0DTE, NECESITA el servidor de Tito
REM  levantado: la logica vive en una ruta de la app. Si el puerto 3000 no
REM  responde, lo arranca y espera hasta ~30 s; si no llega a tiempo, se deja
REM  para la corrida siguiente (son cada 10 minutos) en vez de encadenar
REM  arranques.
REM ==========================================================================
set "PATH=C:\Program Files\nodejs;%PATH%"
set "WEBDIR=%~dp0.."
cd /d "%WEBDIR%"

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
node "scripts\trades-run.mjs"
exit /b %errorlevel%
