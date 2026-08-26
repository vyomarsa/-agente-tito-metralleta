' Lanza el refresco de la bitacora SIN ventana (window style 0). Corre cada 10
' minutos de sesion, asi que una consola parpadeando seria molesta.
Dim fso, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """ & here & "\trades-run.cmd"""
CreateObject("WScript.Shell").Run cmd, 0, False
