# Package the backend as a single executable for the desktop app (Tauri sidecar) on Windows.
# Output: frontend\src-tauri\binaries\jarvis-backend-<target-triple>.exe
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\backend")
.venv\Scripts\python.exe -m pip install -q -e ".[build]"
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean jarvis-backend.spec
$triple = (rustc -vV | Select-String "^host: ").ToString().Substring(6).Trim()
New-Item -ItemType Directory -Force ..\frontend\src-tauri\binaries | Out-Null
Copy-Item dist\jarvis-backend.exe "..\frontend\src-tauri\binaries\jarvis-backend-$triple.exe"
Write-Host "Sidecar: frontend\src-tauri\binaries\jarvis-backend-$triple.exe"
