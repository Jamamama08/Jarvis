# Run JARVIS for everyday use on Windows (no hot reload): builds the web app if needed, then
# serves it and the API at http://127.0.0.1:8765. Run scripts\setup.ps1 first.
param([switch]$Rebuild)
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
if ($Rebuild -or -not (Test-Path (Join-Path $root "frontend\dist\index.html"))) {
  Push-Location (Join-Path $root "frontend"); npx vite build; Pop-Location
}
Set-Location (Join-Path $root "backend")
.venv\Scripts\python.exe -m app.main
