@echo off
setlocal
REM ==========================================================================
REM  Quita las tareas del paper trading de Venta de Prima de Tito.
REM  NO borra nada de la cuenta: las posiciones abiertas y el libro de cerrados
REM  siguen en web\data\prima-positions.json y web\data\prima-closed.jsonl.
REM  Solo deja de dispararse solo; se puede seguir a mano desde /trades.
REM ==========================================================================
echo Quitando las tareas de Paper Venta Prima...
schtasks /delete /tn "TitoMetralleta-Prima-Scan" /f
schtasks /delete /tn "TitoMetralleta-Prima-Open"    /f
schtasks /delete /tn "TitoMetralleta-Prima-Manage"  /f
schtasks /delete /tn "TitoMetralleta-Prima-Viernes" /f
echo.
echo LISTO. La cuenta y el libro NO se han tocado.
echo.
pause
