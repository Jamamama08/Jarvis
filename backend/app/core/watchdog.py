"""Parent-process watchdog for the desktop sidecar.

The desktop app passes its process id in JARVIS_PARENT_PID. If that process goes
away for any reason (window closed, crash, killed), the backend shuts itself down,
so it never lingers in the background. This also covers PyInstaller one-file
builds, where the desktop app's handle points at a bootloader rather than the
server process itself.
"""

import asyncio
import logging
import os
import signal
from collections.abc import Callable

log = logging.getLogger(__name__)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":  # pragma: no cover - Windows only
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def shutdown_self() -> None:
    if os.name == "nt":  # pragma: no cover - Windows has no SIGTERM handler for uvicorn
        os._exit(0)  # SQLite (WAL) is crash-safe; nothing is lost
    os.kill(os.getpid(), signal.SIGTERM)  # uvicorn shuts down gracefully


async def watch_parent(pid: int, on_gone: Callable[[], None] = shutdown_self, interval: float = 2.0) -> None:
    while pid_alive(pid):
        await asyncio.sleep(interval)
    log.info("Desktop app (pid %s) has exited; shutting down the backend.", pid)
    on_gone()
