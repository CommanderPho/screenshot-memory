$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$distCli = Join-Path $ScriptDir "..\dist\cli.js"

if (-not $env:OLLAMA_HOST) {
    $env:OLLAMA_HOST = "http://127.0.0.1:11434"
}

$bunExe = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
if (-not $bunExe) {
    $userBun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $userBun) { $bunExe = $userBun }
}

if ($bunExe) {
    & $bunExe $distCli @args
} else {
    & node $distCli @args
}
