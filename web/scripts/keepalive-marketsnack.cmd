@echo off
REM Wrapper del keep-alive de MarketSnack: añade Node al PATH y corre el worker.
REM Lo invoca la tarea programada (a través de keepalive-hidden.vbs, sin ventana).
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0.."
node "scripts\keepalive-marketsnack.mjs"
