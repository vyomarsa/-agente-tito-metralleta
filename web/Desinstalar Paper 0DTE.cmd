@echo off
echo Quitando la tarea del paper del 0DTE...
schtasks /delete /tn "TitoMetralleta-0DTE-Paper" /f
echo.
echo Hecho. La cuenta deja de correr sola; seguira avanzando solo mientras
echo tengas la pagina /0dte abierta en sesion.
pause
