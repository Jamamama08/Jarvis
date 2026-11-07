#!/usr/bin/env bash
# Run JARVIS for everyday use (no hot reload): builds the web app if needed, then serves
# it and the API from the backend at http://127.0.0.1:8765. Run scripts/setup.sh first.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f frontend/dist/index.html ] || [ "${1:-}" = "--rebuild" ]; then
  (cd frontend && npx vite build)
fi
cd backend && exec .venv/bin/python -m app.main
