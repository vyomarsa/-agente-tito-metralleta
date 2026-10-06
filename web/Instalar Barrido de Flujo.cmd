@echo off
REM ==========================================================================
REM  Instala la tarea que barre el FLUJO del universo con Tastytrade.
REM
REM  Sustituye al "flujo de todo el mercado" de MarketSnack: su streamer no
REM  tiene feed de mercado, asi que hay que recorrer los 102 simbolos uno a uno
REM  (~8 min). Por eso corre UNA vez al dia, DESPUES del cierre, y las pantallas
REM  (/ideas, piloto swing, put/call del Pulso) leen la foto que deja.
REM
REM  La ventana es LOCAL y ancha (16:20-20:20) a proposito: el filtro fino
REM  —dia habil, sesion ya cerrada, y no repetir si ya se barrio hoy— lo hace el
REM  worker en hora de Nueva York, porque en noviembre ET pasa a UTC-5 y una
REM  ventana atada al reloj local se desplazaria una hora.
REM ==========================================================================
set "VBS=%~dp0scripts\flow-hidden.vbs"

echo Instalando TitoMetralleta-Barrido-Flujo ...
schtasks /create /tn "TitoMetralleta-Barrido-Flujo" /tr "wscript.exe \"%VBS%\"" /sc daily /st 16:20 /ri 30 /du 0004:00 /f
if errorlevel 1 goto error

REM  Mismos flags que el resto de tareas y por los mismos motivos: schtasks deja
REM  por defecto "no arrancar con bateria" y "parar al pasar a bateria" (en un
REM  portatil eso es no correr el dia que no estas enchufado, y en silencio);
REM  WakeToRun despierta el equipo, que aqui usa Modern Standby y se duerme
REM  aunque powercfg diga Nunca; StartWhenAvailable recupera la corrida perdida.
REM  El limite de 25 min mata un barrido colgado sin bloquear el del dia siguiente.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -MultipleInstances IgnoreNew; Set-ScheduledTask -TaskName 'TitoMetralleta-Barrido-Flujo' -Settings $s | Out-Null"

echo.
echo Listo. El flujo del universo se barre solo tras el cierre.
echo   Bitacora: data\flow-run.log
echo   Estado: GET /api/flow-sweep
echo   Desinstalar: "Desinstalar Barrido de Flujo.cmd"
goto fin

:error
echo.
echo FALLO al crear la tarea. Prueba a ejecutar este .cmd como administrador.

:fin
pause
