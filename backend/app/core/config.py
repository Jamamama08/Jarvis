"""Application configuration loaded from environment variables / .env.

Secrets (e.g. ANTHROPIC_API_KEY) are read here and never sent to the frontend.
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="JARVIS_",
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Server -------------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 8765
    # Origins allowed to call the API from a browser (Vite dev server, Tauri webview).
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ]
    )
    # When set, FastAPI serves the built frontend from this directory (single-origin web app).
    frontend_dist: Path | None = REPO_ROOT / "frontend" / "dist"

    # --- Data ---------------------------------------------------------------
    data_dir: Path = REPO_ROOT / "data"
    database_url: str | None = None  # defaults to sqlite file in data_dir

    # --- Auth ---------------------------------------------------------------
    session_ttl_hours: int = 24 * 14
    min_password_length: int = 8
    # Required for first-run account setup when the server binds to a non-loopback address.
    setup_token: SecretStr | None = None

    # --- AI (Claude) -------------------------------------------------------------
    # Read without the JARVIS_ prefix so the standard variable name works.
    anthropic_api_key: SecretStr | None = Field(default=None, validation_alias="ANTHROPIC_API_KEY")
    default_model: str = "claude-opus-5-5"
    max_output_tokens: int = Field(default=16000, ge=256, le=128_000)
    # Approximate history budget sent to Claude per turn (oldest turns are dropped first).
    max_context_tokens: int = Field(default=150_000, ge=2_000)
    request_timeout_seconds: float = Field(default=300.0, gt=0)
    max_retries: int = Field(default=2, ge=0, le=10)
    # Server-side refusal fallback: if Claude's safety classifiers decline a request,
    # the API retries it on Anthropic's recommended fallback model.
    refusal_fallback: bool = True

    # --- Tools & agent loop -----------------------------------------------------
    # Files the file tools may read/write and the Python tool runs in. Nothing outside is reachable.
    workspace_dir: Path | None = None  # default: <data_dir>/workspace
    max_tool_iterations: int = Field(default=10, ge=1, le=50)  # model calls per user message
    turn_timeout_seconds: float = Field(default=600.0, gt=0)  # whole turn, including tool runs
    turn_token_budget: int = Field(default=400_000, ge=10_000)  # input + output tokens per turn
    tool_timeout_seconds: float = Field(default=30.0, gt=0)  # one tool run
    approval_timeout_seconds: float = Field(default=300.0, gt=0)  # waiting for you to approve
    max_tool_output_chars: int = Field(default=20_000, ge=1_000)
    python_tool_enabled: bool = True

    # --- Browser automation (Phase 6) ---------------------------------------------------
    browser_enabled: bool = True
    browser_headless: bool = True  # set false to watch the browser work (desktop use)
    # Pages on private/loopback/link-local addresses (your router, NAS, this machine) are blocked
    # unless enabled, so web content can't use JARVIS to reach your local network.
    browser_allow_private_network: bool = False
    browser_idle_timeout_seconds: float = Field(default=600.0, gt=0)
    browser_navigation_timeout_seconds: float = Field(default=30.0, gt=0)

    # --- Autonomous tasks (Phase 7) -----------------------------------------------------
    task_token_budget: int = Field(default=1_000_000, ge=10_000)  # all requests of one task
    task_timeout_seconds: float = Field(default=1800.0, gt=0)
    task_approval_timeout_seconds: float = Field(default=3600.0, gt=0)  # you may not be watching
    max_concurrent_tasks: int = Field(default=2, ge=1, le=10)  # per user
    task_retry_base_seconds: float = Field(default=2.0, ge=0)  # backoff for transient API errors

    # --- Desktop control (Phase 6) ------------------------------------------------------
    # None = on only when the server listens on loopback (i.e. it runs on your own machine).
    desktop_control_enabled: bool | None = None

    @property
    def desktop_control_active(self) -> bool:
        if self.desktop_control_enabled is not None:
            return self.desktop_control_enabled
        return self.host in ("127.0.0.1", "localhost", "::1")

    @property
    def resolved_workspace_dir(self) -> Path:
        return (self.workspace_dir or self.data_dir / "workspace").resolve()

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{(self.data_dir / 'jarvis.db').as_posix()}"

    @property
    def sqlite_path(self) -> Path | None:
        url = self.resolved_database_url
        prefix = "sqlite+aiosqlite:///"
        if url.startswith(prefix) and ":memory:" not in url:
            return Path(url[len(prefix):])
        return None


@lru_cache
def get_settings() -> Settings:
    return Settings()
