' Launch the screenshot-memory tray helper without a console window.
Option Explicit

Dim shell, fso, scriptDir, trayPs1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
trayPs1 = scriptDir & "\ssm-tray.ps1"

If Not fso.FileExists(trayPs1) Then
  MsgBox "Could not find ssm-tray.ps1 next to this launcher.", vbCritical, "screenshot-memory"
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & trayPs1 & """"
shell.Run cmd, 0, False
