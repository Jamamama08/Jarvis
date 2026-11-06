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
