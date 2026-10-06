@echo off
setlocal
REM ==========================================================================
REM  Instala la tarea programada que mantiene viva la sesion de MarketSnack.
REM  Corre cada EVERY minutos, oculta, y guarda la cookie rotada. Log en
REM  web\data\keepalive.log (visible tambien en la pagina /ajustes).
REM  Para quitarla: doble clic en "Desinstalar KeepAlive MarketSnack.cmd".
REM ==========================================================================
set "TASK=TitoMetralleta-MarketSnack-KeepAlive"
set "VBS=%~dp0scripts\keepalive-hidden.vbs"
set "EVERY=15"

echo Creando tarea "%TASK%" (cada %EVERY% min)...
schtasks /create /tn "%TASK%" /tr "wscript.exe \"%VBS%\"" /sc minute /mo %EVERY% /f

REM  WakeToRun DESPIERTA el equipo para correr, y hace falta de verdad: este
REM  portatil usa Modern Standby (S0), que NO lo gobiernan los tiempos de
REM  suspension de powercfg (estan todos en Nunca y aun asi se duerme). El
REM  2026-09-07 se durmio por la manana y las tareas perdidas se dispararon todas
REM  juntas a las 16:45 ET, cinco horas tarde. Solo surte efecto si el plan de
REM  energia permite temporizadores de reactivacion (SUB_SLEEP RTCWAKE); con
REM  bateria suelen venir desactivados.
REM
REM  schtasks deja por defecto "no arrancar con bateria" y "parar al pasar a
REM  bateria". Este keep-alive mantiene viva la cookie de MarketSnack, de la que
REM  dependen la vista, los screeners y LOS DOS simuladores de paper: si no corre
REM  un dia sin enchufe, la sesion caduca y todo lo demas falla en cascada (paso
REM  el 2026-08-17 y se perdio la ventana de apertura semanal). Solo PowerShell
REM  puede tocar esos flags.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew; Set-ScheduledTask -TaskName '%TASK%' -Settings $s | Out-Null"
if not "%errorlevel%"=="0" (
  echo.
  echo *** No se pudo crear la tarea ^(errorlevel %errorlevel%^). ***
  echo Si pide permisos, abre este .cmd con "Ejecutar como administrador".
  pause
  exit /b 1
)

echo.
echo Lanzando una primera pasada de prueba...
schtasks /run /tn "%TASK%" >nul 2>&1

echo.
echo LISTO. La tarea corre cada %EVERY% minutos mientras tu sesion de Windows
echo este iniciada. Revisa el estado en la pagina /ajustes de Tito.
echo.
pause
