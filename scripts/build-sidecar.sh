#!/usr/bin/env bash
# Package the backend as a single executable for the desktop app (Tauri sidecar).
# Output: frontend/src-tauri/binaries/jarvis-backend-<target-triple>
set -euo pipefail
cd "$(dirname "$0")/../backend"
.venv/bin/python -m pip install -q -e '.[build]' 2>/dev/null || uv pip install -q -e '.[build]'
.venv/bin/python -m PyInstaller --noconfirm --clean jarvis-backend.spec
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
mkdir -p ../frontend/src-tauri/binaries
cp dist/jarvis-backend "../frontend/src-tauri/binaries/jarvis-backend-$TRIPLE"
echo "Sidecar: frontend/src-tauri/binaries/jarvis-backend-$TRIPLE"
