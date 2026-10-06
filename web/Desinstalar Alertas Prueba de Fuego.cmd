@echo off
REM Quita las tres tareas de alertas de Telegram de Prueba de Fuego.
for %%T in (TitoMetralleta-PdF-SPX TitoMetralleta-PdF-ES TitoMetralleta-PdF-Premarket) do (
  schtasks /delete /tn "%%T" /f
)
echo.
echo Listo.
pause
