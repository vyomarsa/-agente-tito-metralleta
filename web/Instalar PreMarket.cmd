@echo off
REM ==========================================================================
REM  Instala la tarea del SUB-AGENTE DE PRE-MARKET.
REM
REM  QUE HACE: de lunes a viernes, hacia las 9:00 ET (30 min antes de abrir),
REM  manda por Telegram el analisis de SPY, QQQ, SPX y las 7 magnificas:
REM  medias moviles de 55 y 200 en velas de 4H, notional value de las opciones
REM  y las noticias que mueven mercado. No opera nada.
REM
REM  UNA tarea cada 5 minutos. La ventana es LOCAL y generosa (08:30-10:30) a
REM  proposito: el filtro fino (8:55-9:25 ET, una vez al dia) lo hace el worker
REM  en hora de Nueva York, porque en noviembre ET pasa a UTC-5 y una ventana
REM  atada al reloj local se desplazaria una hora medio ano.
REM ==========================================================================
set "VBS=%~dp0scripts\premarket-hidden.vbs"

echo Instalando TitoMetralleta-PreMarket ...
schtasks /create /tn "TitoMetralleta-PreMarket" /tr "wscript.exe \"%VBS%\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 08:30 /ri 5 /du 0002:00 /f
if errorlevel 1 goto error

REM  Mismos flags que las otras tareas (ver "Instalar Bitacora Scalping.cmd"):
REM  correr con bateria, recuperar la corrida si el equipo dormia, DESPERTARLO
REM  (Modern Standby) y matar una corrida colgada. 12 min: el informe tarda ~4.
powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -MultipleInstances IgnoreNew; Set-ScheduledTask -TaskName 'TitoMetralleta-PreMarket' -Settings $s | Out-Null"

echo.
echo Listo. El pre-market llegara por Telegram cada dia habil hacia las 9:00 ET.
echo   Bitacora: data\premarket-run.log
echo   Probar ya: node scripts\premarket-run.mjs --forzar
echo   Desinstalar: "Desinstalar PreMarket.cmd"
goto fin

:error
echo.
echo FALLO al crear la tarea. Prueba a ejecutar este .cmd como administrador.

:fin
pause
