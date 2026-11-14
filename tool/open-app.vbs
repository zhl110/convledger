' Double-click launcher: ensure the hub is up, then open the dedicated app window.
' App-window only (2026-11-14): the hub gates on a token; plain browser access is 403.
Option Explicit
Dim fso, sh, here, root, logFile, rc, detail
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
If Not fso.FolderExists(here & "\out") Then fso.CreateFolder(here & "\out")
logFile = here & "\out\open-app.log"
sh.CurrentDirectory = root
rc = sh.Run("cmd /c node """ & here & "\bin\convledger.mjs"" app > """ & logFile & """ 2>&1", 0, True)
If rc <> 0 Then
  detail = ""
  On Error Resume Next
  detail = fso.OpenTextFile(logFile, 1).ReadAll
  On Error GoTo 0
  MsgBox "convledger app failed (exit " & rc & ")." & vbCrLf & vbCrLf & detail, 16, "convledger"
End If
WScript.Quit rc
