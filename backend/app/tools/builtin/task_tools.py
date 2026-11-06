"""Tools to start and check autonomous tasks from chat."""

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.models import PermissionLevel, Task
from app.tools.base import Tool, ToolContext, ToolError


class StartTaskInput(BaseModel):
    goal: str = Field(min_length=5, max_length=4000, description="What the task must achieve, with all the details and constraints the user gave (the task can't ask questions).")


async def _start(ctx: ToolContext, a: StartTaskInput) -> str:
    from app.services.tasks import TaskError

    runner = ctx.services.get("tasks")
    if runner is None:
        raise ToolError("Autonomous tasks aren't available.")
    try:
        task = await runner.start(ctx.user_id, a.goal, conversation_id=ctx.conversation_id)
    except TaskError as exc:
        raise ToolError(exc.message) from exc
    return (f"Started autonomous task {task.id}: {task.title}. It runs in the background; the user can follow it "
            "and approve actions on the Tasks page. Use check_task to report on it later.")


class CheckTaskInput(BaseModel):
    task_id: str | None = Field(default=None, description="A task id; omit to list the latest tasks.")


async def _check(ctx: ToolContext, a: CheckTaskInput) -> str:
    stmt = select(Task).where(Task.user_id == ctx.user_id, Task.kind == "agent")
    if a.task_id:
        stmt = stmt.where(Task.id == a.task_id)
    tasks = list((await ctx.db.execute(stmt.order_by(Task.created_at.desc()).limit(5))).scalars())
    if not tasks:
        return "No autonomous tasks found."
    out = []
    for t in tasks:
        steps = list((await ctx.db.execute(select(Task).where(Task.parent_id == t.id).order_by(Task.created_at))).scalars())
        done = sum(1 for s in steps if s.status.value == "completed")
        line = f"- {t.title} (id {t.id}): {t.status.value}, {done}/{len(steps)} steps done"
        if t.result:
            line += f"\n  Result: {t.result[:1500]}"
        if t.error:
            line += f"\n  Problem: {t.error[:500]}"
        out.append(line)
    return "\n".join(out)


start_task = Tool(
    "start_task",
    "Start an autonomous background task for multi-step work that would take many tool calls (research and write-ups, "
    "organising files, comparing options across several websites). JARVIS plans the steps, runs them, and verifies "
    "the result while the user does something else. Not for quick questions. Needs the user's approval.",
    StartTaskInput, PermissionLevel.restricted, _start, timeout=30.0, summarize=lambda a: a.goal[:160],
)
check_task = Tool(
    "check_task", "Check the status and results of the user's autonomous tasks.", CheckTaskInput,
    PermissionLevel.automatic, _check, summarize=lambda a: a.task_id or "latest",
)
