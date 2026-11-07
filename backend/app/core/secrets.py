"""Server-side secret storage.

Secrets (the Anthropic API key, email passwords, private calendar URLs, webhook
URLs) never go into the database, the browser or logs. They live in
<data_dir>/secrets.json, readable only by the account running JARVIS (mode 0600 on
Linux/macOS; on Windows the data folder is inside your user profile). Writes are
atomic. Environment variables (e.g. ANTHROPIC_API_KEY in .env) take precedence for
server-wide settings.
"""

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any


class SecretStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".secrets-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            if os.name == "posix":
                os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._read().get(key, default)

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            data = self._read()
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
            self._write(data)

    # Per-user integration settings live under "user:<id>".
    def user(self, user_id: str) -> dict:
        return dict(self.get(f"user:{user_id}", {}) or {})

    def update_user(self, user_id: str, section: str, value: dict | None) -> None:
        with self._lock:
            data = self._read()
            entry = dict(data.get(f"user:{user_id}", {}) or {})
            if value is None:
                entry.pop(section, None)
            else:
                entry[section] = value
            data[f"user:{user_id}"] = entry
            self._write(data)
