@echo off
setlocal enabledelayedexpansion
REM ==========================================================================
REM  Wrapper del barrido de flujo del universo (Tastytrade).
REM    flow-run.cmd [--forzar]
REM
REM  NECESITA el servidor de Tito levantado: la logica vive en una ruta de la
REM  app. Si el puerto 3000 no responde, lo arranca y espera hasta ~90 s, igual
REM  que el worker de venta de prima: esto corre una vez al dia y perderlo
REM  significa quedarse sin foto del flujo hasta manana.
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
if !tries! lss 30 goto waitloop
exit /b 1

:run
node "scripts\flow-run.mjs" %*
exit /b %errorlevel%
