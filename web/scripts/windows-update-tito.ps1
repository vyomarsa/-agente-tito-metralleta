# Ajusta Windows Update para que no tumbe a Tito durante la sesion de mercado.
# Requiere administrador. Re-ejecutable: Windows puede revertir esto tras una
# actualizacion grande de version.
#
# 1) Horas activas 08:00-18:00 LOCAL. La maquina va en UTC-4 FIJO (sin horario
#    de verano), asi que la sesion de NY se desplaza: 9:30-16:00 local en verano
#    y 10:30-17:00 en invierno. La ventana cubre las dos, mas las tareas
#    programadas que arrancan a las 09:00.
# 2) ARSO: tras un reinicio por actualizacion, Windows vuelve a iniciar sesion
#    solo (dejando la pantalla BLOQUEADA) y con ello corre la carpeta de Inicio,
#    que es lo unico que levanta a Tito. Sin esto el PC se queda en la pantalla
#    de bloqueo y no hay dashboard hasta que alguien teclee la contrasena.

$ErrorActionPreference = 'Stop'

$ux  = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
$wl  = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$pol = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'

function Valor($ruta, $nombre) {
  try { (Get-ItemProperty -Path $ruta -Name $nombre -ErrorAction Stop).$nombre } catch { $null }
}

$copia = [ordered]@{
  ActiveHoursStart              = Valor $ux  'ActiveHoursStart'
  ActiveHoursEnd                = Valor $ux  'ActiveHoursEnd'
  SmartActiveHoursState         = Valor $ux  'SmartActiveHoursState'
  ARSOUserConsent               = Valor $wl  'ARSOUserConsent'
  DisableAutomaticRestartSignOn = Valor $pol 'DisableAutomaticRestartSignOn'
}

$destino = Join-Path $PSScriptRoot 'windows-update-tito.backup.json'
$copia | ConvertTo-Json | Out-File -FilePath $destino -Encoding utf8
Write-Host "Valores anteriores guardados en: $destino"
$copia.GetEnumerator() | ForEach-Object { Write-Host ("  {0} = {1}" -f $_.Key, $(if ($null -eq $_.Value) { '(sin definir)' } else { $_.Value })) }

Write-Host ''
Write-Host 'Aplicando...'

# Horas activas manuales. SmartActiveHoursState=0 evita que Windows las
# reajuste solo segun cuando uses el equipo y vuelva a abrir la sesion.
New-ItemProperty -Path $ux -Name 'ActiveHoursStart'      -Value 8  -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $ux -Name 'ActiveHoursEnd'        -Value 18 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $ux -Name 'SmartActiveHoursState' -Value 0  -PropertyType DWord -Force | Out-Null

# ARSO activado. La directiva DisableAutomaticRestartSignOn=1 lo anularia.
New-ItemProperty -Path $wl -Name 'ARSOUserConsent' -Value 1 -PropertyType DWord -Force | Out-Null
if (-not (Test-Path $pol)) { New-Item -Path $pol -Force | Out-Null }
New-ItemProperty -Path $pol -Name 'DisableAutomaticRestartSignOn' -Value 0 -PropertyType DWord -Force | Out-Null

Write-Host ''
Write-Host 'Resultado:'
Write-Host ("  Horas activas (NO reinicia): {0:00}:00 -> {1:00}:00" -f (Valor $ux 'ActiveHoursStart'), (Valor $ux 'ActiveHoursEnd'))
Write-Host ("  Reajuste automatico de horas activas: {0}" -f (Valor $ux 'SmartActiveHoursState'))
Write-Host ("  ARSOUserConsent: {0}" -f (Valor $wl 'ARSOUserConsent'))
Write-Host ("  DisableAutomaticRestartSignOn: {0}" -f (Valor $pol 'DisableAutomaticRestartSignOn'))
Write-Host ''
Write-Host 'Listo.'
