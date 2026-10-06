@echo off
setlocal enabledelayedexpansion
REM ==========================================================================
REM  Wrapper del sub-agente de pre-market (Telegram 30 min antes de la apertura).
REM
REM  Como los otros tres workers, NECESITA el servidor de Tito levantado: la
REM  logica vive en una ruta de la app. Si el puerto 3000 no responde, lo arranca
REM  y espera hasta ~90 s.
REM
REM  La espera larga vale la pena: el informe es una vez al dia y la ventana
REM  (8:55-9:25 ET) se acaba con la apertura.
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
node "scripts\premarket-run.mjs" %*
exit /b %errorlevel%
