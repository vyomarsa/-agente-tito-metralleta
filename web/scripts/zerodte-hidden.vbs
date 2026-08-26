' Lanza el tick del paper del 0DTE SIN ventana (window style 0). Corre cada
' minuto durante la sesion, asi que una consola parpadeando seria insufrible.
Dim fso, here, cmd, ticker
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ticker = "SPY"
If WScript.Arguments.Count > 0 Then ticker = WScript.Arguments(0)
cmd = "cmd /c """ & here & "\zerodte-run.cmd"" " & ticker
CreateObject("WScript.Shell").Run cmd, 0, False
