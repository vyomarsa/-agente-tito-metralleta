@echo off
setlocal enabledelayedexpansion
REM ==========================================================================
REM  Wrapper del paso de bitacora del Playbook del Rango (fase 1).
REM
REM  Como los otros tres workers, NECESITA el servidor de Tito levantado: la
REM  logica vive en una ruta de la app. Si el puerto 3000 no responde, lo arranca
REM  y espera hasta ~90 s.
REM
REM  Aqui la espera larga SI vale la pena, al reves que en el 0DTE: la ventana de
REM  anotacion es de una sola vez al dia y no hay segunda oportunidad hasta
REM  manana. Con diez sesiones de muestra, perder una es el 10% del experimento.
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
node "scripts\scalping-run.mjs"
exit /b %errorlevel%
