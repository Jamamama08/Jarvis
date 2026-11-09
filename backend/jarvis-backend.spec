# PyInstaller spec for the desktop sidecar. Build with scripts/build-sidecar.(sh|ps1).
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hiddenimports = (
    collect_submodules("app")
    + collect_submodules("uvicorn")
    + collect_submodules("aiosqlite")
    + collect_submodules("pptx")  # imported lazily by services/slides.py
    + collect_submodules("pypdf")
    + ["sqlalchemy.dialects.sqlite.aiosqlite", "sqlalchemy.dialects.sqlite.pysqlite"]
)
datas = [("alembic", "alembic"), ("alembic.ini", ".")]
datas += collect_data_files("recurring_ical_events") + collect_data_files("icalendar") + collect_data_files("anthropic") + collect_data_files("pptx")

a = Analysis(
    ["jarvis_server.py"],
    pathex=["."],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "aiosmtpd", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="jarvis-backend",
    console=True,  # the desktop app hides the console window of its sidecar
    upx=False,
)
