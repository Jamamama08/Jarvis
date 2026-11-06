"""Desktop control: launch applications the user approved, and open workspace
documents with their default app.

Safety rules:
- Only apps the user registered (absolute path to an existing file) can be launched;
  Claude cannot add apps.
- The app's arguments are fixed at registration. JARVIS may add at most one extra
  "target" if the user allowed it, and only an http(s) URL or a file inside the
  workspace; anything starting with "-" (a command-line flag) is refused.
- Documents opened with their default app must not be executables or scripts.
- Child processes don't inherit JARVIS secrets (API keys, tokens).
- Desktop control is only active when the backend runs on this machine (loopback),
  unless explicitly enabled.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

#: File types that run code when "opened"; open_workspace_file refuses them.
EXECUTABLE_SUFFIXES = frozenset({
    ".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp",
    ".scr", ".pif", ".lnk", ".url", ".reg", ".hta", ".cpl", ".jar", ".sh", ".bash", ".zsh", ".command", ".app",
    ".py", ".pyw", ".pl", ".rb", ".php", ".desktop", ".appimage", ".run", ".bin", ".dll", ".so", ".dylib",
    ".applescript", ".scpt", ".workflow", ".action", ".pkg", ".dmg", ".deb", ".rpm", ".iso", ".img",
})
_SECRET_ENV = re.compile(r"(?i)(anthropic|api[_-]?key|token|secret|password|jarvis_)")
NAME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$"


class DesktopError(Exception):
    pass


def safe_env() -> dict[str, str]:
    """The user's environment minus anything secret-looking (apps need PATH, HOME, display vars, etc.)."""
    return {k: v for k, v in os.environ.items() if not _SECRET_ENV.search(k)}


def validate_app_path(path: str) -> Path:
    p = Path(path).expanduser()
    if not p.is_absolute():
        raise DesktopError("Use the full path to the application, e.g. C:\\Program Files\\App\\app.exe.")
    if not p.exists():
        raise DesktopError("No file exists at that path.")
    if p.is_dir() and p.suffix.lower() != ".app":
        raise DesktopError("That's a folder, not an application.")
    return p


def validate_args(args: list[str]) -> list[str]:
    if len(args) > 20:
        raise DesktopError("Too many arguments (max 20).")
    for a in args:
        if not isinstance(a, str) or len(a) > 500 or "\x00" in a or "\n" in a:
            raise DesktopError("Arguments must be single-line text.")
    return args


def validate_target(target: str, workspace: Path) -> str:
    """A target is an http(s) URL or a path inside the workspace. Never a flag."""
    target = target.strip()
    if not target or len(target) > 2000 or any(c in target for c in "\x00\r\n"):
        raise DesktopError("Invalid target.")
    if target.startswith("-"):
        raise DesktopError("Targets can't start with '-' (command-line options aren't allowed).")
    parts = urlsplit(target)
    if parts.scheme in ("http", "https") and parts.netloc:
        return target
    if parts.scheme and len(parts.scheme) > 1:  # e.g. file:, javascript:, ms-settings: (single letter = Windows drive)
        raise DesktopError("Only http(s) web addresses or files in the workspace can be opened.")
    candidate = Path(target)
    full = (candidate if candidate.is_absolute() else workspace / candidate).resolve()
    if not full.is_relative_to(workspace):
        raise DesktopError("Files must be inside the workspace folder.")
    if not full.exists():
        raise DesktopError("No such file in the workspace.")
    return str(full)


def launch(path: str, args: list[str], target: str | None) -> int:
    """Start the app detached from JARVIS. Returns the process id."""
    p = Path(path)
    command: list[str]
    if sys.platform == "darwin" and p.suffix.lower() == ".app":
        command = ["open", "-a", str(p), *([target] if target else []), "--args", *args]
    else:
        command = [str(p), *args, *([target] if target else [])]
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "env": safe_env(),
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    else:
        kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(command, **kwargs)  # noqa: S603 - no shell; path from the user's allow-list
    except OSError as exc:
        raise DesktopError(f"Couldn't start the app: {exc.strerror or exc}") from exc
    return proc.pid


def default_open(path: Path) -> None:
    """Open a file with the operating system's default application."""
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606
        return
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        subprocess.Popen([opener, str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,  # noqa: S603
                         stderr=subprocess.DEVNULL, env=safe_env(), start_new_session=True)
    except OSError as exc:
        raise DesktopError(f"No default app opener available ({opener}).") from exc


def check_openable(path: Path) -> None:
    if path.is_dir():
        raise DesktopError("That's a folder; only files can be opened.")
    if path.suffix.lower() in EXECUTABLE_SUFFIXES:
        raise DesktopError(f"{path.suffix} files can run code, so JARVIS won't open them. Open it yourself if you trust it.")
    if os.name != "nt" and os.access(path, os.X_OK):
        raise DesktopError("That file is marked executable, so JARVIS won't open it.")
