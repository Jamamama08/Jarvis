"""All built-in tools."""

from app.tools.builtin.automation import (
    browser_back,
    browser_click,
    browser_close,
    browser_open,
    browser_read,
    browser_select,
    browser_type,
    list_desktop_apps,
    open_desktop_app,
    open_workspace_file,
)
from app.tools.builtin.basic import calculator, current_datetime
from app.tools.builtin.data_tools import (
    create_task,
    delete_task,
    list_tasks,
    search_memories,
    suggest_memory,
    update_task,
)
from app.tools.builtin.files import delete_file, read_file, search_files, write_file
from app.tools.builtin.python_exec import run_python
from app.tools.builtin.summarize import summarize_document

BUILTIN_TOOLS = [
    calculator,
    current_datetime,
    read_file,
    search_files,
    write_file,
    delete_file,
    summarize_document,
    create_task,
    list_tasks,
    update_task,
    delete_task,
    search_memories,
    suggest_memory,
    run_python,
    browser_open,
    browser_read,
    browser_back,
    browser_click,
    browser_type,
    browser_select,
    browser_close,
    list_desktop_apps,
    open_desktop_app,
    open_workspace_file,
]
