' Lanza el paso de la bitacora del Playbook del Rango SIN ventana (window style 0).
' Corre cada 10 minutos en dos ventanas del dia, asi que una consola parpadeando
' seria molesta.
Dim fso, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """ & here & "\scalping-run.cmd"""
CreateObject("WScript.Shell").Run cmd, 0, False
