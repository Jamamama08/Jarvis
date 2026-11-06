"""Autonomous task endpoints: start, list, detail (plan, steps, tool activity, approvals), cancel, re-run."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete, select

from app.api.deps import CurrentUser, DbSession
from app.models import Task, ToolExecution
from app.schemas import ToolExecutionOut
from app.services.tasks import ACTIVE, TaskError, task_tokens
from app.tools.executor import to_out

router = APIRouter(prefix="/api/agent-tasks", tags=["agent tasks"])


class StartBody(BaseModel):
    goal: str = Field(min_length=5, max_length=4000)


class StepOut(BaseModel):
    id: str
    index: int
    title: str
    instructions: str
    depends_on: list[int]
    parallel_safe: bool
    status: str
    result: str | None
    error: str | None
    attempts: int
    started_at: datetime | None
    finished_at: datetime | None


class AgentTaskOut(BaseModel):
    id: str
    title: str
    goal: str
    status: str
    plan_summary: str
    result: str | None
    error: str | None
    issues: list[str]
    conversation_id: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    steps_total: int
    steps_done: int
    tokens: int
    estimated_cost_usd: float | None
    running: bool


class AgentTaskDetail(AgentTaskOut):
    steps: list[StepOut]
    tools: list[ToolExecutionOut]


def _runner(request: Request):
    return request.app.state.task_runner


async def _owned(db, user_id: str, task_id: str) -> Task:
    task = await db.get(Task, task_id)
    if task is None or task.user_id != user_id or task.kind != "agent":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")
    return task


async def _steps(db, task_id: str) -> list[Task]:
    return list((await db.execute(select(Task).where(Task.parent_id == task_id).order_by(Task.created_at))).scalars())


async def _summary(db, request: Request, task: Task, steps: list[Task]) -> dict:
    usage = (await task_tokens(db, [task.id, *[s.id for s in steps]]))
    tokens = sum(u["tokens"] for u in usage.values())
    costs = [u["cost"] for u in usage.values()]
    plan = task.plan or {}
    return dict(
        id=task.id, title=task.title, goal=task.description, status=task.status.value,
        plan_summary=plan.get("summary", ""), result=task.result, error=task.error, issues=plan.get("issues", []),
        conversation_id=task.conversation_id, created_at=task.created_at, started_at=task.started_at,
        finished_at=task.finished_at, steps_total=len(steps),
        steps_done=sum(1 for s in steps if s.status.value == "completed"), tokens=tokens,
        estimated_cost_usd=None if any(c is None for c in costs) else round(sum(costs), 6),
        running=_runner(request).is_running(task.id),
    )


@router.post("", response_model=AgentTaskOut, status_code=status.HTTP_201_CREATED)
async def start(body: StartBody, request: Request, user: CurrentUser, db: DbSession):
    try:
        task = await _runner(request).start(user.id, body.goal)
    except TaskError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    task = await db.get(Task, task.id)
    return await _summary(db, request, task, [])


@router.get("", response_model=list[AgentTaskOut])
async def list_tasks(request: Request, user: CurrentUser, db: DbSession):
    tasks = (await db.execute(select(Task).where(Task.user_id == user.id, Task.kind == "agent").order_by(Task.created_at.desc()).limit(100))).scalars()
    return [await _summary(db, request, t, await _steps(db, t.id)) for t in tasks]


@router.get("/{task_id}", response_model=AgentTaskDetail)
async def detail(task_id: str, request: Request, user: CurrentUser, db: DbSession):
    task = await _owned(db, user.id, task_id)
    steps = await _steps(db, task.id)
    executions = (
        await db.execute(select(ToolExecution).where(ToolExecution.task_id.in_([s.id for s in steps])).order_by(ToolExecution.created_at))
    ).scalars() if steps else []
    step_out = [
        StepOut(
            id=s.id, index=(s.plan or {}).get("index", i + 1), title=s.title, instructions=s.description,
            depends_on=(s.plan or {}).get("depends_on", []), parallel_safe=bool((s.plan or {}).get("parallel_safe")),
            status=s.status.value, result=s.result, error=s.error, attempts=s.attempts,
            started_at=s.started_at, finished_at=s.finished_at,
        )
        for i, s in enumerate(steps)
    ]
    return {**(await _summary(db, request, task, steps)), "steps": step_out,
            "tools": [to_out(e, summary=(e.input or {}).get("_summary", "")) for e in executions]}


@router.post("/{task_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel(task_id: str, request: Request, user: CurrentUser, db: DbSession) -> None:
    task = await _owned(db, user.id, task_id)
    if not _runner(request).cancel(task.id, user.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "This task isn't running.")


@router.post("/{task_id}/rerun", response_model=AgentTaskOut, status_code=status.HTTP_201_CREATED)
async def rerun(task_id: str, request: Request, user: CurrentUser, db: DbSession):
    task = await _owned(db, user.id, task_id)
    try:
        new = await _runner(request).start(user.id, task.description, conversation_id=task.conversation_id)
    except TaskError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    return await _summary(db, request, await db.get(Task, new.id), [])


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete(task_id: str, request: Request, user: CurrentUser, db: DbSession) -> None:
    task = await _owned(db, user.id, task_id)
    if task.status in ACTIVE or _runner(request).is_running(task.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Cancel the task before deleting it.")
    # Steps are removed by the database cascade (tasks.parent_id ON DELETE CASCADE); tool logs and
    # usage rows are kept with their task link cleared (ON DELETE SET NULL).
    await db.execute(sa_delete(Task).where(Task.id == task.id))
    await db.commit()
