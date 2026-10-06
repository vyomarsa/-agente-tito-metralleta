' Lanza el barrido de flujo SIN ventana (window style 0). Son varios minutos de
' trabajo: una consola abierta todo ese rato solo estorba.
Dim fso, here, cmd, i, args
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
cmd = "cmd /c """ & here & "\flow-run.cmd""" & args
CreateObject("WScript.Shell").Run cmd, 0, False
