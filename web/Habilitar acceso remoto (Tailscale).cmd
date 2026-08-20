@echo off
title Tito Metralleta - Habilitar acceso remoto (Tailscale)
REM Crea la regla de firewall que permite entrar al agente (puerto 3000)
REM SOLO desde la red de Tailscale (100.64.0.0/10). Nadie mas puede alcanzarlo.
REM Se auto-eleva: al abrirlo saldra una ventana de Windows (UAC) -> pulsa "Si".

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Solicitando permisos de administrador (pulsa "Si" en la ventana de Windows)...
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

echo Creando la regla de firewall...
powershell -NoProfile -Command ^
  "Get-NetFirewallRule -DisplayName 'Tito Metralleta 3000 (Tailscale)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName 'Tito Metralleta 3000 (Tailscale)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 -RemoteAddress 100.64.0.0/10 -Profile Any | Out-Null; Write-Host 'Regla creada OK. Ya puedes entrar desde el iPhone/iPad por Tailscale.'"

echo.
echo Listo. Puedes cerrar esta ventana.
pause
