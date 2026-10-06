@echo off
REM ==========================================================================
REM  Instala las alertas de Telegram de Prueba de Fuego (Visionary Trades):
REM
REM   TitoMetralleta-PdF-SPX        cada 1 min, lun-vie 09:00-17:10 hora LOCAL.
REM   TitoMetralleta-PdF-ES         cada 1 min, todos los dias, 24 h.
REM   TitoMetralleta-PdF-Premarket  cada 5 min, lun-vie 09:00-11:00 hora LOCAL.
REM
REM  Las ventanas LOCALES son amplias a proposito: esta PC va en UTC-4 todo el
REM  ano y Nueva York pasa a UTC-5 en noviembre. El filtro fino lo hace cada
REM  script en hora de Nueva York (mercado abierto para SPX/ES; 9:15 y 9:30 ET
REM  para el pre-market, una vez cada una por dia).
REM
REM  Telegram: usa el bot de Tito (data\telegram.json). Solo avisa cuando una
REM  senal CAMBIA de verdad, no cada minuto.
REM ==========================================================================
set "VBS=%~dp0scripts\pdf-alerts\hidden.vbs"

echo Instalando TitoMetralleta-PdF-SPX ...
schtasks /create /tn "TitoMetralleta-PdF-SPX" /tr "wscript.exe \"%VBS%\" spx" /sc weekly /d MON,TUE,WED,THU,FRI /st 09:00 /ri 1 /du 0008:10 /f
if errorlevel 1 goto error

echo Instalando TitoMetralleta-PdF-ES ...
schtasks /create /tn "TitoMetralleta-PdF-ES" /tr "wscript.exe \"%VBS%\" es" /sc daily /st 00:00 /ri 1 /du 0024:00 /f
if errorlevel 1 goto error

echo Instalando TitoMetralleta-PdF-Premarket ...
schtasks /create /tn "TitoMetralleta-PdF-Premarket" /tr "wscript.exe \"%VBS%\" premarket" /sc weekly /d MON,TUE,WED,THU,FRI /st 09:00 /ri 5 /du 0002:00 /f
if errorlevel 1 goto error

powershell -NoProfile -Command "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew; 'TitoMetralleta-PdF-SPX','TitoMetralleta-PdF-ES','TitoMetralleta-PdF-Premarket' | ForEach-Object { Set-ScheduledTask -TaskName $_ -Settings $s | Out-Null }"

echo.
echo Listo. Alertas de Prueba de Fuego instaladas.
echo   Log 0DTE:       data\pdf\odte-standalone\ticket-alert.log
echo   Log pre-market: data\pdf\premarket-movers.log
echo   Desinstalar:    "Desinstalar Alertas Prueba de Fuego.cmd"
goto fin

:error
echo.
echo FALLO al crear la tarea. Prueba a ejecutar este .cmd como administrador.

:fin
pause
