Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\Download\GoogleDownload\my-ai-assistant"
WshShell.Run "cmd /c npx electron . --no-sandbox", 0, False
