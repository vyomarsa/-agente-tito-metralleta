@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "C:\Users\VYOMA\Desktop\VyoBot\agente-tito-metralleta\web"

REM UN SOLO servidor. Varias tareas programadas (0DTE cada minuto, prima, flujo...)
REM llaman a este script si :3000 no responde; al arrancar Windows lo hacian a la
REM vez y Next saltaba a 3001/3002/3003 -> varios "next dev" pisando el mismo .next
REM -> la portada daba 404. Si ya hay alguien escuchando en 3000, no hacemos nada;
REM y con -p 3000 explicito Next NO busca otro puerto: el duplicado falla y sale.
netstat -ano | findstr /R /C:"127\.0\.0\.1:3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo Tito ya esta corriendo en el puerto 3000.
  exit
)

call "C:\Program Files\nodejs\node.exe" "node_modules\next\dist\bin\next" dev -H 127.0.0.1 -p 3000
