' Lanza run.cmd SIN ventana (window style 0): las alertas corren cada minuto
' y una consola parpadeando seria molesta. Uso: wscript hidden.vbs spx|es|premarket
Dim fso, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c """ & here & "\run.cmd"" " & WScript.Arguments(0)
CreateObject("WScript.Shell").Run cmd, 0, False
