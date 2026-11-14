' convledger tray launcher.
' Use the GUI-subsystem wscript to start a hidden PowerShell:
' a direct spawn dies with the launcher, while "cmd start" flashes a black console.
' wscript has no console; Run style 0 hides the PowerShell window.
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 3 Then WScript.Quit 2
Dim cmd
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ _
    & WScript.Arguments(0) & """ -Root """ & WScript.Arguments(1) & """ -Node """ & WScript.Arguments(2) & """"
sh.Run cmd, 0, False
