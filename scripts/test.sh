#!/usr/bin/env bash
# Run every test suite: backend (pytest), frontend unit (vitest), end-to-end (Playwright).
set -euo pipefail
cd "$(dirname "$0")/.."
(cd backend && .venv/bin/pytest -q)
(cd frontend && npx tsc --noEmit && npx vitest run && npx vite build && npx playwright test --trace off)
