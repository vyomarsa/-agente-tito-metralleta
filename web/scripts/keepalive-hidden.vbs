' Lanza el keep-alive de MarketSnack SIN ventana (window style 0), para que la
' tarea programada no haga parpadear una consola cada pocos minutos.
Dim fso, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """ & here & "\keepalive-marketsnack.cmd"""
CreateObject("WScript.Shell").Run cmd, 0, False
