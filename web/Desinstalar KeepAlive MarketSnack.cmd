@echo off
setlocal
set "TASK=TitoMetralleta-MarketSnack-KeepAlive"
echo Eliminando la tarea "%TASK%"...
schtasks /delete /tn "%TASK%" /f
echo.
if "%errorlevel%"=="0" (
  echo Tarea eliminada. El keep-alive ya no correra.
) else (
  echo No habia tarea que eliminar ^(o no se pudo^).
)
echo.
pause
