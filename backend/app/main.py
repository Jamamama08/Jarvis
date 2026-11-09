"""FastAPI application factory and entrypoint."""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import asyncio
import os

import anthropic
import anyio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app import __version__
from app.api import agent_tasks, auth, automation, conversations, integrations, lessons, memories, system, tools
from app.core.config import Settings, get_settings
from app.core.db import Database
from app.core.secrets import SecretStore
from app.core.watchdog import watch_parent
from app.core.logging import configure_logging
from app.migrations import upgrade_to_head
from app.services.backup import backup_scheduler
from app.services.chat import GenerationRegistry
from app.services.lessons import LessonRunner
from app.services.providers import build_provider
from app.automation.browser import BrowserManager
from app.services.tasks import TaskRunner
from app.tools.executor import ApprovalBroker
from app.tools.registry import default_registry

log = logging.getLogger("jarvis")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        configure_logging()
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.resolved_workspace_dir.mkdir(parents=True, exist_ok=True)
        await anyio.to_thread.run_sync(upgrade_to_head, settings.resolved_database_url)
        app.state.db = Database(settings)
        app.state.task_runner = TaskRunner(
            sessionmaker=app.state.db.sessionmaker, settings=settings, provider=app.state.provider,
            tools=app.state.tools, approvals=app.state.approvals, services=app.state.tool_services,
        )
        app.state.tool_services["tasks"] = app.state.task_runner
        app.state.lessons = LessonRunner(app.state.db.sessionmaker)
        backups = asyncio.create_task(backup_scheduler(settings), name="backup-scheduler")
        parent_pid = os.environ.get("JARVIS_PARENT_PID", "")
        watchdog = asyncio.create_task(watch_parent(int(parent_pid)), name="parent-watchdog") if parent_pid.isdigit() else None
        interrupted = await app.state.task_runner.recover()
        if interrupted:
            log.warning("Marked %d interrupted task(s) as failed", interrupted)
        if await app.state.lessons.recover():
            log.warning("Marked interrupted lesson builds as failed")
        log.info("JARVIS %s ready (db=%s, ai=%s)", __version__, settings.sqlite_path, app.state.provider.name)
        try:
            yield
        finally:
            backups.cancel()
            if watchdog:
                watchdog.cancel()
            await app.state.task_runner.shutdown()
            await app.state.lessons.shutdown()
            await app.state.browser.shutdown()
            await app.state.db.dispose()

    app = FastAPI(title="JARVIS", version=__version__, lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.secrets = SecretStore(settings.data_dir / "secrets.json")
    app.state.provider = build_provider(settings, app.state.secrets.get("anthropic_api_key"))
    app.state.generations = GenerationRegistry()
    app.state.login_limiter = auth.LoginRateLimiter()
    app.state.tools = default_registry()
    app.state.approvals = ApprovalBroker()
    app.state.browser = BrowserManager(settings)
    app.state.tool_services = {"browser": app.state.browser, "secrets": app.state.secrets}
    # Builds the client used to validate a newly entered API key (replaceable in tests).
    app.state.key_check_client = lambda key: anthropic.AsyncAnthropic(api_key=key, max_retries=1, timeout=20)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.add_middleware(SecurityHeadersMiddleware)

    app.include_router(system.router)
    app.include_router(auth.router)
    app.include_router(conversations.router)
    app.include_router(memories.router)
    app.include_router(tools.router)
    app.include_router(automation.router)
    app.include_router(agent_tasks.router)
    app.include_router(integrations.router)
    app.include_router(lessons.router)

    _mount_frontend(app, settings.frontend_dist)
    return app


class SecurityHeadersMiddleware:
    """Adds security headers. Plain ASGI (not BaseHTTPMiddleware) so streaming responses and
    client disconnects aren't disturbed by an extra task layer."""

    HEADERS = [
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"DENY"),
        (b"referrer-policy", b"no-referrer"),
    ]

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                message = {**message, "headers": [*message.get("headers", []), *[(k, v) for k, v in self.HEADERS if k not in existing]]}
            await send(message)

        await self.app(scope, receive, send_with_headers)


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
