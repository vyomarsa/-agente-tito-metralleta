@echo off
echo Quitando la tarea del refresco de la bitacora...
schtasks /delete /tn "TitoMetralleta-Bitacora-Swing" /f
echo.
echo Hecho. La bitacora deja de avanzar sola: volvera a moverse solo cuando
echo pulses "Actualizar" en Mis Trades. Ojo, eso significa que los stops no se
echo ejecutan mientras no estes mirando.
pause
