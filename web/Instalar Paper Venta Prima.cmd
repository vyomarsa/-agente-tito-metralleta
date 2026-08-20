@echo off
setlocal
REM ==========================================================================
REM  Instala las tareas del paper trading de VENTA DE PRIMA dentro de Tito y
REM  JUBILA las del bot Python (Desktop\Venta Prima).
REM
REM  Cadencia (plan del dueno): abrir lunes/martes -> revisar miercoles -> vencer viernes.
REM    Prima-Open      lun-mar 11:45        escanea 103 simbolos y abre
REM    Prima-Manage    lun-vie 14:30        valvula del 30% y gestion
REM    Prima-Viernes   viernes cada 30 min  suelo de ganancia intradia (10:30-16:00)
REM
REM  Las tareas VentaPrima-* del bot Python se BORRAN a proposito: mientras las dos
REM  mitades corrian a la vez habia DOS consumidores de la cookie de MarketSnack,
REM  y el que no guarda la cookie rotada le rompe la sesion al otro. Ese fue el
REM  fallo del 2026-08-17. Una sola app, un solo almacen de cookie.
REM
REM  Para quitarlo todo: "Desinstalar Paper Venta Prima.cmd".
REM ==========================================================================
set "VBS=%~dp0scripts\prima-hidden.vbs"

echo ============================================
echo   Paper Venta Prima - instalacion en Tito
echo ============================================
echo.

echo [1/2] Creando las tareas de Tito...
schtasks /create /tn "TitoMetralleta-Prima-Open"    /tr "wscript.exe \"%VBS%\" open"   /sc weekly /d MON,TUE /st 11:45 /f
if not "%errorlevel%"=="0" goto fallo
schtasks /create /tn "TitoMetralleta-Prima-Manage"  /tr "wscript.exe \"%VBS%\" manage" /sc weekly /d MON,TUE,WED,THU,FRI /st 14:30 /f
if not "%errorlevel%"=="0" goto fallo
schtasks /create /tn "TitoMetralleta-Prima-Viernes" /tr "wscript.exe \"%VBS%\" manage" /sc weekly /d FRI /st 10:30 /ri 30 /du 05:30 /f
if not "%errorlevel%"=="0" goto fallo

echo.
echo [2/3] Ajustando las tareas (recuperar disparos perdidos y correr con bateria)...
REM  schtasks no expone estas dos, y las dos importan en una laptop:
REM   - StartWhenAvailable: si el PC estaba dormido a las 11:45 del lunes, corre al
REM     despertar. Es seguro porque el motor tiene su propia ventana 10:30-16:00 ET:
REM     si despierta tarde, bloquea en vez de abrir con precios de mercado cerrado.
REM   - DisallowStartIfOnBatteries: viene en TRUE por defecto, o sea que sin enchufe
REM     la tarea se saltaba en silencio. Justo el fallo mudo que queremos evitar.
powershell -NoProfile -Command "foreach ($n in 'TitoMetralleta-Prima-Open','TitoMetralleta-Prima-Manage','TitoMetralleta-Prima-Viernes') { $t = Get-ScheduledTask -TaskName $n; $t.Settings.StartWhenAvailable = $true; $t.Settings.DisallowStartIfOnBatteries = $false; $t.Settings.StopIfGoingOnBatteries = $false; Set-ScheduledTask -TaskName $n -Settings $t.Settings | Out-Null }"

echo.
echo [3/3] Jubilando las tareas del bot Python...
schtasks /delete /tn "VentaPrima-Paper-Open"      /f 2>nul
schtasks /delete /tn "VentaPrima-Paper-Manage"    /f 2>nul
schtasks /delete /tn "VentaPrima-Paper-Viernes"   /f 2>nul
schtasks /delete /tn "VentaPrima-DashboardRefresh" /f 2>nul

echo.
echo LISTO. Ahora la venta de prima corre DENTRO de Tito.
echo   - Cuenta y trades: http://localhost:3000/trades  (pestana "Venta Prima")
echo   - Bitacora de las corridas: web\data\prima-run.log
echo.
echo Requisitos: la sesion de Windows iniciada y la cookie de MarketSnack viva
echo (revisala en la pagina /ajustes de Tito). Si Tito esta cerrado cuando toque
echo una corrida, la tarea lo arranca sola.
echo.
pause
exit /b 0

:fallo
echo.
echo *** No se pudo crear alguna tarea ^(errorlevel %errorlevel%^). ***
echo Si pide permisos, abre este .cmd con "Ejecutar como administrador".
pause
exit /b 1
