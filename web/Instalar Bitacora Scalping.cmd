@echo off
REM ==========================================================================
REM  Instala la tarea que lleva sola la BITACORA del Playbook del Rango
REM  (pestana Scalping, fase 1: solo observar).
REM
REM  QUE HACE: de 8:00 a 9:35 ET congela los tres niveles y el semaforo de cada
REM  ticker seguido; despues del cierre califica las sesiones pendientes contra
REM  las velas de 5 minutos. No opera nada y no puede operar nada.
REM
REM  POR QUE: el manual manda anotar los niveles CADA manana durante dos semanas.
REM  Una bitacora que solo avanza al abrir la pestana mide la constancia del
REM  usuario, no la estrategia, y con diez sesiones de muestra dos dias perdidos
REM  son el 20% del experimento.
REM
REM  UNA tarea cada 10 minutos. La ventana es LOCAL y generosa (07:30-17:00) a
REM  proposito: el filtro fino lo hace el worker en hora de Nueva York, porque en
REM  noviembre ET pasa a UTC-5 y una ventana atada al reloj local se desplazaria
REM  media sesion medio ano. Fuera de las dos ventanas el worker no toca la red.
REM ==========================================================================
set "VBS=%~dp0scripts\scalping-hidden.vbs"

echo Instalando TitoMetralleta-Bitacora-Scalping ...
schtasks /create /tn "TitoMetralleta-Bitacora-Scalping" /tr "wscript.exe \"%VBS%\"" /sc daily /st 07:30 /ri 10 /du 0009:30 /f
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
REM  equipo estaba dormido, que es justo lo que salva la ventana de la manana.
REM  El limite de 10 min mata un paso colgado para que el siguiente pueda entrar.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew; Set-ScheduledTask -TaskName 'TitoMetralleta-Bitacora-Scalping' -Settings $s | Out-Null"

echo.
echo Listo. La bitacora del rango ya se lleva sola.
echo   Bitacora de corridas: data\scalping-run.log
echo   Ver estado: pestana Scalping
echo   Desinstalar: "Desinstalar Bitacora Scalping.cmd"
goto fin

:error
echo.
echo FALLO al crear la tarea. Prueba a ejecutar este .cmd como administrador.

:fin
pause
