"""FastAPI application factory and entrypoint."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.requests import Request
from starlette.responses import Response

from app import __version__
from app.api import auth, conversations, system
from app.core.config import Settings, get_settings
from app.core.db import Database
from app.core.logging import configure_logging
from app.migrations import upgrade_to_head
from app.services.chat import GenerationRegistry
from app.services.providers import build_provider

log = logging.getLogger("jarvis")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging()
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        await anyio.to_thread.run_sync(upgrade_to_head, settings.resolved_database_url)
        app.state.db = Database(settings)
        log.info("JARVIS %s ready (db=%s, ai=%s)", __version__, settings.sqlite_path, app.state.provider.name)
        try:
            yield
        finally:
            await app.state.db.dispose()

    app = FastAPI(title="JARVIS", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.provider = build_provider(settings)
    app.state.generations = GenerationRegistry()
    app.state.login_limiter = auth.LoginRateLimiter()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    app.include_router(system.router)
    app.include_router(auth.router)
    app.include_router(conversations.router)

    _mount_frontend(app, settings.frontend_dist)
    return app


def _mount_frontend(app: FastAPI, dist: Path | None) -> None:
    """Serve the built SPA (if present) so the web app is a single origin."""
    if not dist or not (dist / "index.html").exists():
        return
    root = dist.resolve()
    index = root / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404)
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


def run() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    run()
