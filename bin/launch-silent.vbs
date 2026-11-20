Option Explicit
Dim shell, fso, rootDir, cliPath, nodeCheck, cmd, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cliPath = fso.BuildPath(rootDir, "src\cli.js")
nodeCheck = shell.Run("cmd /c where node >nul 2>&1", 0, True)
If nodeCheck <> 0 Then
  MsgBox "Node.js (v20 or later) was not found." & vbCrLf & "Please install Node.js and try again.", vbCritical, "Antigravity Japanese UI"
  WScript.Quit 1
End If
cmd = "node """ & cliPath & """ launch --gui"
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next
shell.Run cmd, 0, False
