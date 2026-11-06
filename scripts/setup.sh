#!/usr/bin/env bash
# One-time setup: Python venv + backend deps, frontend deps, .env from example.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
python3 -m venv backend/.venv
backend/.venv/bin/pip install -q --upgrade pip
backend/.venv/bin/pip install -q -e 'backend[dev]'
(cd frontend && npm install)
(cd backend && .venv/bin/python -m app.cli migrate)
echo "Setup complete. Run scripts/dev.sh to start JARVIS."
