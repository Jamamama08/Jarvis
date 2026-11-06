"""Controlled Python execution (restricted: every run needs the user's approval
unless they choose otherwise).

Safeguards: a separate process in isolated mode (-I), the workspace as working
directory, a scrubbed environment (no API keys or other secrets are inherited),
a wall-clock timeout that kills the process, output limits, and on Linux/macOS
CPU, memory and file-size limits. This is NOT a security sandbox: the code runs
with your user account's permissions, which is why it requires approval.
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from pydantic import BaseModel, Field

from app.models import PermissionLevel
from app.tools.base import Tool, ToolContext, ToolError

MAX_CODE_CHARS = 50_000
OUTPUT_LIMIT = 20_000
MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024  # 1 GB
FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024


def _safe_env() -> dict[str, str]:
    keep = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def _limits(cpu_seconds: int):  # pragma: no cover - runs in the child process
    def apply() -> None:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_SIZE_LIMIT_BYTES, FILE_SIZE_LIMIT_BYTES))
        os.setsid()

    return apply


async def run_python_code(code: str, cwd: Path, timeout: float) -> tuple[int | None, str, str, bool]:
    """Returns (exit code or None on timeout, stdout, stderr, timed_out)."""
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(code)
        script = f.name
    try:
        kwargs: dict = {}
        if os.name == "posix":
            kwargs["preexec_fn"] = _limits(max(1, int(timeout)))
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-X", "utf8", script,
            cwd=str(cwd),
            env=_safe_env(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
            return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace"), False
        except (TimeoutError, asyncio.CancelledError):
            proc.kill()
            await proc.wait()
            if asyncio.current_task() and asyncio.current_task().cancelling():
                raise
            return None, "", "", True
    finally:
        Path(script).unlink(missing_ok=True)


class RunPythonInput(BaseModel):
    code: str = Field(description="A complete Python 3 script. Print the results you need. Runs in the workspace folder with only the standard library.")


def _clip(text: str) -> str:
    return text if len(text) <= OUTPUT_LIMIT else text[:OUTPUT_LIMIT] + f"\n… [truncated {len(text) - OUTPUT_LIMIT} characters]"


async def _run_python(ctx: ToolContext, args: RunPythonInput) -> str:
    if len(args.code) > MAX_CODE_CHARS:
        raise ToolError("Code is too long.")
    timeout = ctx.settings.tool_timeout_seconds
    code, out, err, timed_out = await run_python_code(args.code, ctx.workspace, timeout)
    if timed_out:
        raise ToolError(f"The script was stopped after {timeout:g} seconds.")
    parts = [f"Exit code: {code}"]
    if out:
        parts.append("stdout:\n" + _clip(out))
    if err:
        parts.append("stderr:\n" + _clip(err))
    if code != 0:
        raise ToolError("\n".join(parts))
    return "\n".join(parts) if (out or err) else "Exit code: 0 (no output)"


run_python = Tool(
    name="run_python",
    description="Run a short Python 3 script (standard library only) in the user's workspace folder and return its output. Use for data processing, analysis of workspace files, or computations too complex for the calculator. Each run needs the user's approval.",
    input_model=RunPythonInput,
    level=PermissionLevel.restricted,
    handler=_run_python,
    timeout=None,  # the subprocess enforces tool_timeout_seconds itself and kills the process
    summarize=lambda a: (a.code.strip().splitlines() or [""])[0][:80] + (" …" if "\n" in a.code.strip() else ""),
    enabled=lambda settings: settings.python_tool_enabled,
)
