Option Explicit

Dim fso, wshShell, scriptDir, daemonScript, nodeExe, candidateProgFiles, candidateLocal, cmd, exitCode

Set fso = CreateObject("Scripting.FileSystemObject")
Set wshShell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
daemonScript = fso.BuildPath(scriptDir, "agent-daemon.js")

candidateProgFiles = wshShell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
candidateLocal = wshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe")

If fso.FileExists(candidateProgFiles) Then
  nodeExe = candidateProgFiles
ElseIf fso.FileExists(candidateLocal) Then
  nodeExe = candidateLocal
Else
  nodeExe = "node.exe"
End If

cmd = """" & nodeExe & """ """ & daemonScript & """"
exitCode = wshShell.Run(cmd, 0, True)
WScript.Quit exitCode
