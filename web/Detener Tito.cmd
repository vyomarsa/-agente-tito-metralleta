@echo off
title Tito Metralleta - Detener
echo Deteniendo el servidor de Tito Metralleta...

REM Mata cualquier proceso node que escuche en el puerto 3000.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  echo   Cerrando proceso %%p...
  taskkill /PID %%p /F >nul 2>&1
)

echo Listo. El servidor esta detenido.
timeout /t 2 /nobreak >nul
exit /b
