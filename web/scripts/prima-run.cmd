@echo off
setlocal enabledelayedexpansion
REM ==========================================================================
REM  Wrapper del paper trading de Venta de Prima.
REM    prima-run.cmd open     → apertura semanal (la tarea la lanza los lunes)
REM    prima-run.cmd manage   → gestion de las abiertas
REM
REM  A diferencia del keep-alive, esto NECESITA el servidor de Tito levantado,
REM  porque la estrategia vive en una ruta de la app. Si el puerto 3000 no
REM  responde, lo arranca igual que "Iniciar Tito.cmd" y espera a que este listo.
REM  Sin esto, un lunes con el PC encendido pero Tito cerrado se perderia la
REM  unica ventana de apertura de la semana, en silencio.
REM ==========================================================================
set "PATH=C:\Program Files\nodejs;%PATH%"
set "WEBDIR=%~dp0.."
cd /d "%WEBDIR%"

set "MODE=%~1"
if "%MODE%"=="" set "MODE=manage"

curl -s -o nul http://127.0.0.1:3000
if not errorlevel 1 goto run

echo Tito no responde. Arrancando el servidor...
start "Tito Metralleta - Servidor (NO CERRAR)" /min "%WEBDIR%\start-dev.cmd"

REM Espera hasta ~90 s (30 intentos x 3 s). Compilar la primera vez tarda.
set /a tries=0
:waitloop
timeout /t 3 /nobreak >nul
curl -s -o nul http://127.0.0.1:3000
if not errorlevel 1 goto run
set /a tries+=1
if !tries! lss 30 goto waitloop
echo El servidor no arranco a tiempo. El worker lo registrara como ERROR.

:run
node "scripts\prima-run.mjs" %MODE%
exit /b %errorlevel%
