' Double-click launcher: ensure the hub is up (reuse it if already running),
' then open this project's newest canvas in the default browser.
' Closing the browser tab does not stop the hub; this script only brings the page back.
Option Explicit
Dim fso, sh, here, root, logFile, rc, detail
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
If Not fso.FolderExists(here & "\out") Then fso.CreateFolder(here & "\out")
logFile = here & "\out\open-map.log"
sh.CurrentDirectory = root
rc = sh.Run("cmd /c node """ & here & "\bin\convledger.mjs"" map --open > """ & logFile & """ 2>&1", 0, True)
If rc <> 0 Then
  detail = ""
  On Error Resume Next
  detail = fso.OpenTextFile(logFile, 1).ReadAll
  On Error GoTo 0
  MsgBox "convledger map failed (exit " & rc & ")." & vbCrLf & vbCrLf & detail, 16, "convledger"
End If
WScript.Quit rc
