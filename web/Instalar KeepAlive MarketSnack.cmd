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
