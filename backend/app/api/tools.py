"""Tools, permissions, approvals, execution history and the task list."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from app.api.deps import AppSettings, CurrentUser, DbSession
from app.models import PermissionDecision, PermissionLevel, Task, TaskStatus, ToolExecution
from app.schemas import (
    PermissionLevelInfo,
    PolicyUpdate,
    TaskCreate,
    TaskOut,
    TaskUpdate,
    ToolDecision,
    ToolExecutionOut,
    ToolInfo,
    ToolsOverview,
)
from app.services.preferences import load_preferences
from app.tools import permissions
from app.tools.executor import to_out
from app.tools.server_tools import SERVER_TOOL_NAMES

router = APIRouter(prefix="/api", tags=["tools"])

SERVER_TOOL_INFO = {
    "web_search": "Search the web (run by Anthropic). Billed at $10 per 1,000 searches plus tokens.",
    "web_fetch": "Fetch the text of a web page (run by Anthropic). Billed as tokens only.",
}


@router.get("/tools", response_model=ToolsOverview)
async def tools_overview(request: Request, user: CurrentUser, db: DbSession, settings: AppSettings) -> ToolsOverview:
    registry = request.app.state.tools
    policies = await permissions.load_policies(db, user.id)
    prefs = await load_preferences(db, user.id)
    items = []
    for tool in registry.all():
        if permissions.tool_scope(tool.name) in policies:
            rule = "tool"
        elif permissions.level_scope(tool.level) in policies:
            rule = "level"
        else:
            rule = "default"
        items.append(
            ToolInfo(
                name=tool.name, description=tool.description, level=tool.level.value,
                decision=permissions.resolve(tool, policies).value, rule=rule, enabled=tool.enabled(settings),
            )
        )
    for name, description in SERVER_TOOL_INFO.items():
        items.append(ToolInfo(name=name, description=description, level="automatic", decision="allow", rule="default",
                              enabled=prefs.web_search_enabled, server=True))
    levels = [
        PermissionLevelInfo(
            level=level.value,
            decision=(policies.get(permissions.level_scope(level)) or permissions.DEFAULTS[level]).value,
            is_default=permissions.level_scope(level) not in policies,
        )
        for level in PermissionLevel
    ]
    return ToolsOverview(
        tools=items,
        levels=levels,
        workspace_dir=str(settings.resolved_workspace_dir),
        tools_enabled=prefs.tools_enabled,
        web_search_enabled=prefs.web_search_enabled,
        limits={
            "max_tool_iterations": settings.max_tool_iterations,
            "turn_timeout_seconds": settings.turn_timeout_seconds,
            "turn_token_budget": settings.turn_token_budget,
            "tool_timeout_seconds": settings.tool_timeout_seconds,
            "approval_timeout_seconds": settings.approval_timeout_seconds,
        },
    )


@router.put("/tools/policies", status_code=status.HTTP_204_NO_CONTENT)
async def set_policy(body: PolicyUpdate, request: Request, user: CurrentUser, db: DbSession) -> None:
    kind, _, target = body.scope.partition(":")
    if kind == "tool":
        if target in SERVER_TOOL_NAMES:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Web tools are controlled by the web search switch.")
        tool = request.app.state.tools.get(target)
        if tool is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown tool")
        level = tool.level
    else:
        level = PermissionLevel(target)
    try:
        await permissions.set_policy(
            db, user.id, body.scope, PermissionDecision(body.decision) if body.decision else None, level=level
        )
    except permissions.PolicyError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    await db.commit()


@router.post("/tools/executions/{execution_id}/decision", status_code=status.HTTP_204_NO_CONTENT)
async def decide(execution_id: str, body: ToolDecision, request: Request, user: CurrentUser) -> None:
    """Approve or decline a tool call that is waiting for the user."""
    if not request.app.state.approvals.resolve(execution_id, user.id, body.model_dump()):
        raise HTTPException(status.HTTP_409_CONFLICT, "This action is no longer waiting for approval.")


@router.get("/tools/executions", response_model=list[ToolExecutionOut])
async def list_executions(
    user: CurrentUser,
    db: DbSession,
    tool: str | None = Query(default=None, max_length=100),
    status_: str | None = Query(default=None, alias="status", max_length=32),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict]:
    stmt = select(ToolExecution).where(ToolExecution.user_id == user.id)
    if tool:
        stmt = stmt.where(ToolExecution.tool_name == tool)
    if status_:
        stmt = stmt.where(ToolExecution.status == status_)
    rows = (await db.execute(stmt.order_by(ToolExecution.created_at.desc()).limit(limit))).scalars()
    return [to_out(r, summary=(r.input or {}).get("_summary", "")) for r in rows]


# --- Task list -------------------------------------------------------------------------


async def _owned_task(db, user_id: str, task_id: str) -> Task:
    task = await db.get(Task, task_id)
    if task is None or task.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    return task


@router.get("/tasks", response_model=list[TaskOut])
async def list_tasks(user: CurrentUser, db: DbSession, state: Literal["open", "done", "all"] = "all"):
    stmt = select(Task).where(Task.user_id == user.id, Task.parent_id.is_(None))
    if state == "open":
        stmt = stmt.where(Task.status.notin_([TaskStatus.completed, TaskStatus.cancelled, TaskStatus.failed]))
    elif state == "done":
        stmt = stmt.where(Task.status.in_([TaskStatus.completed, TaskStatus.cancelled, TaskStatus.failed]))
    return list((await db.execute(stmt.order_by(Task.created_at.desc()))).scalars())


@router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(body: TaskCreate, user: CurrentUser, db: DbSession):
    task = Task(user_id=user.id, title=body.title.strip(), description=body.description)
    db.add(task)
    await db.commit()
    return task


@router.patch("/tasks/{task_id}", response_model=TaskOut)
async def update_task(task_id: str, body: TaskUpdate, user: CurrentUser, db: DbSession):
    task = await _owned_task(db, user.id, task_id)
    if body.title is not None:
        task.title = body.title.strip()
    if body.description is not None:
        task.description = body.description
    if body.status is not None:
        task.status = TaskStatus(body.status)
        task.finished_at = datetime.now(UTC) if body.status != "pending" else None
    await db.commit()
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(task_id: str, user: CurrentUser, db: DbSession) -> None:
    await db.delete(await _owned_task(db, user.id, task_id))
    await db.commit()
