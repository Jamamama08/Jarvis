# Start backend and Vite dev server on Windows (PowerShell).
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$backend = Start-Process -PassThru -NoNewWindow -WorkingDirectory (Join-Path $root "backend") `
  -FilePath (Join-Path $root "backend\.venv\Scripts\python.exe") `
  -ArgumentList "-m", "uvicorn", "app.main:create_app", "--factory", "--reload", "--host", "127.0.0.1", "--port", "8765"
try { Set-Location (Join-Path $root "frontend"); npm run dev }
finally { Stop-Process -Id $backend.Id -ErrorAction SilentlyContinue }
