@echo off
title Tito Metralleta - Lanzador
set "PATH=C:\Program Files\nodejs;%PATH%"
set "WEBDIR=C:\Users\VYOMA\Desktop\VyoBot\agente-tito-metralleta\web"
cd /d "%WEBDIR%"

echo ============================================
echo   Tito Metralleta - Iniciando dashboard
echo ============================================
echo.

REM Si el servidor ya esta corriendo en el puerto 3000, solo abre el navegador.
curl -s -o nul http://localhost:3000
if %errorlevel%==0 (
  echo El servidor ya estaba corriendo.
  echo Abriendo el dashboard en tu navegador...
  start "" "http://localhost:3000"
  timeout /t 2 /nobreak >nul
  exit /b
)

REM Arranca el servidor en su propia ventana minimizada (no cerrarla).
echo Arrancando el servidor (esto puede tardar 10-20 segundos la primera vez)...
start "Tito Metralleta - Servidor (NO CERRAR)" /min "%WEBDIR%\start-dev.cmd"

REM Espera a que el servidor responda antes de abrir el navegador.
:waitloop
timeout /t 2 /nobreak >nul
curl -s -o nul http://localhost:3000
if errorlevel 1 (
  echo   ...esperando a que el servidor este listo...
  goto waitloop
)

echo.
echo  Listo! Abriendo el dashboard...
start "" "http://localhost:3000"
timeout /t 2 /nobreak >nul
exit /b
