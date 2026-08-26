@echo off
title Tito Metralleta - Detener
echo Deteniendo el servidor de Tito Metralleta...
echo.

REM ---------------------------------------------------------------------------
REM OJO: en el puerto 3000 NO solo escucha Tito.
REM
REM Tailscale (tailscaled.exe) sirve ahi el acceso desde el iPhone
REM   http://laptop-f04ufto6.tailf741db.ts.net:3000  ->  proxy a 127.0.0.1:3000
REM
REM La version anterior de este script mataba CUALQUIER proceso que escuchara en
REM el 3000, asi que de paso tumbaba Tailscale: el movil dejaba de entrar y no
REM volvia hasta reiniciar el servicio. Por eso ahora se comprueba, PID a PID,
REM que se trate de node.exe antes de cerrarlo.
REM
REM El filtro del puerto es ":3000 " (con el espacio) a proposito: sin el,
REM findstr tambien casaria con :30000, :30001, etc.
REM ---------------------------------------------------------------------------

set "ENCONTRADO="

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 " ^| findstr "LISTENING"') do (
  tasklist /fi "PID eq %%p" /fi "IMAGENAME eq node.exe" /nh 2>nul | findstr /i "node.exe" >nul
  if errorlevel 1 (
    echo   PID %%p no es node: lo dejo en paz ^(seguramente Tailscale^).
  ) else (
    echo   Cerrando el servidor de Tito ^(PID %%p^)...
    taskkill /PID %%p /F >nul 2>&1
    set "ENCONTRADO=si"
  )
)

echo.
if defined ENCONTRADO (
  echo Listo. El servidor esta detenido.
) else (
  echo No habia ningun servidor de Tito corriendo en el puerto 3000.
)

REM 2>&1 ademas de >nul: si esto se lanza sin consola interactiva (una tarea, un
REM script), `timeout` no puede leer stdin y escupe un "Input redirection is not
REM supported" que se lee como si el script hubiera fallado. No ha fallado.
timeout /t 3 /nobreak >nul 2>&1
exit /b
