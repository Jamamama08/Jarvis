# One-time setup on Windows (PowerShell): venv + backend deps, frontend deps, .env.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
py -3 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -q --upgrade pip
backend\.venv\Scripts\python.exe -m pip install -q -e "backend[dev]"
Push-Location frontend; npm install; Pop-Location
Push-Location backend; .venv\Scripts\python.exe -m app.cli migrate; Pop-Location
Write-Host "Setup complete. Run scripts\dev.ps1 to start JARVIS."
