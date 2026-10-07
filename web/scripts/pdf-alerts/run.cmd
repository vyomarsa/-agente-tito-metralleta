@echo off
REM ==========================================================================
REM  Alertas de Telegram de Prueba de Fuego (Visionary Trades).
REM    run.cmd spx        -> senales GEX 0DTE de SPX (Ticket / Trade / Alternate)
REM                          + tick de la cuenta paper del Agente Prueba de Fuego (SPY)
REM    run.cmd es         -> lo mismo para /ES
REM    run.cmd premarket  -> S&P 500 que se mueven +-5%% en pre-market
REM  No necesita el servidor de Tito: importa el motor directamente.
REM  Log: data\pdf\odte-standalone\ticket-alert.log, data\pdf\premarket-movers.log
REM       y data\pdf\agente-paper\tick.log
REM ==========================================================================
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0..\.."
if /i "%1"=="spx" call "node_modules\.bin\tsx.cmd" "scripts\pdf-alerts\poll.ts" SPX
if /i "%1"=="spx" call "node_modules\.bin\tsx.cmd" "scripts\pdf-alerts\paper-tick.ts"
if /i "%1"=="es" call "node_modules\.bin\tsx.cmd" "scripts\pdf-alerts\poll.ts" /ES
if /i "%1"=="premarket" call "node_modules\.bin\tsx.cmd" "scripts\pdf-alerts\premarket-scan.ts"
