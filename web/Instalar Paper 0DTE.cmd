@echo off
REM ==========================================================================
REM  Instala la tarea que hace correr la cuenta de paper del 0DTE SOLA,
REM  sin necesidad de tener la pagina abierta.
REM
REM  UNA tarea que se repite cada minuto. La ventana es LOCAL y generosa
REM  (09:00-17:00) a proposito: el filtro fino de sesion (9:30-16:00 ET, solo
REM  dias habiles) lo hace el worker en hora de Nueva York, porque en noviembre
REM  ET cambia a UTC-5 y una ventana atada al reloj local se desplazaria media
REM  sesion medio ano. Fuera de sesion el worker sale sin tocar la red.
REM ==========================================================================
set "VBS=%~dp0scripts\zerodte-hidden.vbs"
set "TICKER=%~1"
if "%TICKER%"=="" set "TICKER=SPY"

echo Instalando TitoMetralleta-0DTE-Paper para %TICKER% ...
schtasks /create /tn "TitoMetralleta-0DTE-Paper" /tr "wscript.exe \"%VBS%\" %TICKER%" /sc daily /st 09:00 /ri 1 /du 0008:00 /f
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
REM  bateria". En un portatil eso significa que la tarea NO corre el dia que no
REM  estas enchufado, y en silencio. Se corrige con PowerShell, que es lo unico
REM  que puede tocar esos flags. StartWhenAvailable recupera la corrida si el
REM  equipo estaba dormido a las 09:00; el limite de 5 min mata un tick colgado
REM  para que el del minuto siguiente pueda entrar.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew; Set-ScheduledTask -TaskName 'TitoMetralleta-0DTE-Paper' -Settings $s | Out-Null"

echo.
echo Listo. La cuenta del 0DTE ya corre sola.
echo   Bitacora: data\zerodte-run.log
echo   Ver estado: pestana 0DTE en Mis Trades
echo   Desinstalar: "Desinstalar Paper 0DTE.cmd"
goto fin

:error
echo.
echo FALLO al crear la tarea. Prueba a ejecutar este .cmd como administrador.

:fin
pause
