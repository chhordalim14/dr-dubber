$WshShell = New-Object -ComObject WScript.Shell
$ShortcutPath = "C:\Users\KOLDER\Desktop\DAI Dubber Pro (Custom).lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "C:\Users\KOLDER\.gemini\antigravity-ide\scratch\ai-dubber-pro\Run-AI-Dubber-Pro.bat"
$Shortcut.WorkingDirectory = "C:\Users\KOLDER\.gemini\antigravity-ide\scratch\ai-dubber-pro"
$Shortcut.IconLocation = "C:\Users\KOLDER\.gemini\antigravity-ide\scratch\ai-dubber-pro\assets\daidubberpro.ico"
$Shortcut.Description = "DAI Dubber Pro - AI Video & Dubbing Studio"
$Shortcut.Save()
Write-Output "Desktop shortcut created at $ShortcutPath"
