"""Entry point for the packaged backend (the desktop app's sidecar).

The desktop app starts this with JARVIS_DATA_DIR set to its app-data folder and
JARVIS_HOST=127.0.0.1, then stops it when the app quits.
"""

import multiprocessing


def main() -> None:
    from app.main import run

    run()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
