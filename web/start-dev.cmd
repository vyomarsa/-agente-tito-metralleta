@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "C:\Users\VYOMA\Desktop\VyoBot\agente-tito-metralleta\web"
call "C:\Program Files\nodejs\node.exe" "node_modules\next\dist\bin\next" dev -H 127.0.0.1
