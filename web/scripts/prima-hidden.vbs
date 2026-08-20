' Lanza el paper trading de Venta de Prima SIN ventana (window style 0), para que
' las tareas programadas no hagan parpadear una consola. El modo (open|manage)
' llega como argumento desde la tarea.
Dim fso, here, cmd, mode
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
mode = "manage"
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)
cmd = "cmd /c """ & here & "\prima-run.cmd"" " & mode
CreateObject("WScript.Shell").Run cmd, 0, False
