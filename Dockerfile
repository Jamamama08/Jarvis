# JARVIS web deployment: one container serving the web app and the API.
# Build: docker build -t jarvis .        Run: docker compose up -d   (see README → Deployment)

# --- 1. Build the frontend -------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- 2. Backend runtime ------------------------------------------------------------------------
FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    JARVIS_HOST=0.0.0.0 \
    JARVIS_PORT=8765 \
    JARVIS_DATA_DIR=/data \
    JARVIS_FRONTEND_DIST=/app/frontend/dist
WORKDIR /app/backend
COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./
RUN pip install --no-cache-dir . \
 && python -m playwright install --with-deps chromium \
 && useradd --create-home --uid 10001 jarvis \
 && mkdir -p /data && chown jarvis /data
COPY --from=web /src/frontend/dist /app/frontend/dist
USER jarvis
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=4)"
CMD ["python", "-m", "app.main"]
