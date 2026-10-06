' Lanza el sub-agente de pre-market SIN ventana (window style 0).
' Corre cada 5 minutos en la ventana de la manana; una consola parpadeando
' seria molesta.
Dim fso, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """ & here & "\premarket-run.cmd"""
CreateObject("WScript.Shell").Run cmd, 0, False
