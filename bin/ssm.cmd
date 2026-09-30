@echo off
setlocal
if "%OLLAMA_HOST%"=="" set "OLLAMA_HOST=http://127.0.0.1:11434"
where bun >nul 2>nul
if %errorlevel% equ 0 (
  bun "%~dp0..\dist\cli.js" %*
) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  "%USERPROFILE%\.bun\bin\bun.exe" "%~dp0..\dist\cli.js" %*
) else (
  node "%~dp0..\dist\cli.js" %*
)
