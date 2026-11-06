#!/usr/bin/env bash
# Start backend (http://127.0.0.1:8765) and Vite dev server (http://localhost:5173) with hot reload.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd backend && .venv/bin/uvicorn app.main:create_app --factory --reload --host 127.0.0.1 --port "${JARVIS_PORT:-8765}") &
BACKEND=$!
trap 'kill $BACKEND 2>/dev/null' EXIT
cd frontend && npm run dev
