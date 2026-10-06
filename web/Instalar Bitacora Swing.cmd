@echo off
REM ==========================================================================
REM  Instala la tarea que refresca sola la BITACORA de Tito (pestanas Todos y
REM  Swing de Mis Trades): re-cotiza los planes abiertos, activa los que cruzan
REM  su gatillo y ejecuta objetivos y stops.
REM
REM  POR QUE: hasta el 2026-08-24 esto solo avanzaba al pulsar "Actualizar". El
REM  ultimo refresco habia sido seis dias antes, asi que los stops de esos seis
REM  dias nunca se ejecutaron y las salidas ocurrieron mucho mas abajo. Un stop
REM  que solo corre cuando hay alguien mirando no es un stop.
REM
REM  UNA tarea cada 10 minutos. La ventana es LOCAL y generosa (09:00-17:00) a
REM  proposito: el filtro fino de sesion (9:30-16:00 ET, dias habiles) lo hace el
REM  worker en hora de Nueva York, porque en noviembre ET pasa a UTC-5 y una
REM  ventana atada al reloj local se desplazaria media sesion medio ano. Fuera de
REM  sesion el worker no re-cotiza nada; lo unico que corre siempre, incluido el fin
REM  de semana, es la pasada de FECHAS (una vez al dia): caduca los planes pendientes
REM  que cumplen 7 dias sin cruzar su gatillo y liberan su ticker. Es calendario, no
REM  mercado, y no toca la red.
REM
REM  Diez minutos y no uno como el 0DTE: cada corrida pide UNA cadena de opciones
REM  por vencimiento abierto, y en planes de varios dias esa holgura es ruido.
REM ==========================================================================
set "VBS=%~dp0scripts\trades-hidden.vbs"

echo Instalando TitoMetralleta-Bitacora-Swing ...
schtasks /create /tn "TitoMetralleta-Bitacora-Swing" /tr "wscript.exe \"%VBS%\"" /sc daily /st 09:00 /ri 10 /du 0008:00 /f
if errorlevel 1 goto error

REM  WakeToRun DESPIERTA el equipo para correr, y hace falta de verdad: este
REM  portatil usa Modern Standby (S0), que NO lo gobiernan los tiempos de
REM  suspension de powercfg (estan todos en Nunca y aun asi se duerme). El
REM  2026-09-07 se durmio por la manana y las tareas perdidas se dispararon todas
REM  juntas a las 16:45 ET, cinco horas tarde. Solo surte efecto si el plan de
REM  energia permite temporizadores de reactivacion (SUB_SLEEP RTCWAKE); con
REM  bateria suelen venir desactivados.
REM
REM  schtasks deja por defecto "no arrancar con bateria" y "parar al pasar a
REM  bateria": en un portatil eso significa que la tarea NO corre el dia que no
REM  estas enchufado, y en silencio. Se corrige con PowerShell, que es lo unico
REM  que puede tocar esos flags. StartWhenAvailable recupera la corrida si el
REM  equipo estaba dormido; el limite de 5 min mata un refresco colgado para que
REM  el siguiente pueda entrar.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew; Set-ScheduledTask -TaskName 'TitoMetralleta-Bitacora-Swing' -Settings $s | Out-Null"

echo.
echo Listo. La bitacora ya se refresca sola.
echo   Bitacora de corridas: data\trades-run.log
echo   Ver estado: pestanas Todos / Swing en Mis Trades
echo   Desinstalar: "Desinstalar Bitacora Swing.cmd"
goto fin

:error
echo.
echo FALLO al crear la tarea. Prueba a ejecutar este .cmd como administrador.

:fin
pause
