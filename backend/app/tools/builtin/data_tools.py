"""Task manager and memory tools."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import select

from app.models import MemoryCategory, PermissionLevel, Task, TaskStatus
from app.services import memory as mem
from app.tools.base import Tool, ToolContext, ToolError

# --- Tasks ---------------------------------------------------------------------------------

TodoStatus = Literal["pending", "completed", "cancelled"]


class CreateTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=300, description="Short task title.")
    description: str = Field(default="", max_length=4000, description="Optional details.")


async def _create_task(ctx: ToolContext, args: CreateTaskInput) -> str:
    task = Task(user_id=ctx.user_id, conversation_id=ctx.conversation_id, title=args.title.strip(), description=args.description)
    ctx.db.add(task)
    await ctx.db.flush()
    return f"Created task {task.id}: {task.title}"


class ListTasksInput(BaseModel):
    status: Literal["open", "completed", "all"] = Field(default="open", description="Which tasks to list.")


async def _list_tasks(ctx: ToolContext, args: ListTasksInput) -> str:
    stmt = select(Task).where(Task.user_id == ctx.user_id, Task.kind == "todo").order_by(Task.created_at)
    if args.status == "open":
        stmt = stmt.where(Task.status.in_([TaskStatus.pending, TaskStatus.running, TaskStatus.waiting_approval]))
    elif args.status == "completed":
        stmt = stmt.where(Task.status == TaskStatus.completed)
    tasks = list((await ctx.db.execute(stmt.limit(200))).scalars())
    if not tasks:
        return "No tasks."
    return "\n".join(f"- [{t.status.value}] {t.title} (id {t.id})" + (f": {t.description[:200]}" if t.description else "") for t in tasks)


class UpdateTaskInput(BaseModel):
    task_id: str = Field(description="The task id from list_tasks.")
    status: TodoStatus | None = Field(default=None, description="New status.")
    title: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=4000)


async def _owned_task(ctx: ToolContext, task_id: str) -> Task:
    task = await ctx.db.get(Task, task_id)
    if task is None or task.user_id != ctx.user_id or task.kind != "todo":
        raise ToolError("No task with that id.")
    return task


async def _update_task(ctx: ToolContext, args: UpdateTaskInput) -> str:
    task = await _owned_task(ctx, args.task_id)
    if args.status:
        task.status = TaskStatus(args.status)
        task.finished_at = datetime.now(UTC) if args.status in ("completed", "cancelled") else None
    if args.title:
        task.title = args.title.strip()
    if args.description is not None:
        task.description = args.description
    return f"Updated task {task.id}: [{task.status.value}] {task.title}"


class DeleteTaskInput(BaseModel):
    task_id: str = Field(description="The task id from list_tasks.")


async def _delete_task(ctx: ToolContext, args: DeleteTaskInput) -> str:
    task = await _owned_task(ctx, args.task_id)
    await ctx.db.delete(task)
    return f"Deleted task: {task.title}"


create_task = Tool("create_task", "Add an item to the user's task list. Use when the user asks you to remember to do something, add a to-do, or plan steps they want tracked.", CreateTaskInput, PermissionLevel.automatic, _create_task, summarize=lambda a: a.title)
list_tasks = Tool("list_tasks", "List the user's tasks (to-dos). Use when the user asks what's on their list or before updating a task.", ListTasksInput, PermissionLevel.automatic, _list_tasks, summarize=lambda a: a.status)
update_task = Tool("update_task", "Change a task's status (e.g. mark it completed), title or description.", UpdateTaskInput, PermissionLevel.automatic, _update_task, summarize=lambda a: f"{a.task_id} -> {a.status or 'edit'}")
delete_task = Tool("delete_task", "Delete a task from the user's list. Prefer marking it completed or cancelled; only delete when asked. Needs the user's approval.", DeleteTaskInput, PermissionLevel.restricted, _delete_task, summarize=lambda a: a.task_id)

# --- Memory --------------------------------------------------------------------------------


class SearchMemoriesInput(BaseModel):
    query: str = Field(min_length=1, max_length=500, description="Words to search for in the user's saved memories.")
    category: MemoryCategory | None = Field(default=None, description="Optional category filter.")


async def _search_memories(ctx: ToolContext, args: SearchMemoriesInput) -> str:
    query = mem.fts_query(args.query, mode="any")
    if not query:
        return "Query has no searchable words."
    from app.models import Memory

    ids = await mem.fts_ids(ctx.db, ctx.user_id, query, approved=True, limit=20)
    found = []
    for mid in ids:
        m = await ctx.db.get(Memory, mid)
        if m and (args.category is None or m.category == args.category):
            found.append(f"- [{m.category.value}, importance {m.importance}] {m.content}")
    return "\n".join(found) if found else "No saved memories match."


class SuggestMemoryInput(BaseModel):
    content: str = Field(min_length=1, max_length=2000, description="One self-contained sentence about the user, e.g. 'Prefers metric units.'")
    category: MemoryCategory = Field(description="preference, personal, project, progress, knowledge or conversation.")
    importance: int = Field(default=3, ge=1, le=5, description="1 (minor) to 5 (use in almost every reply).")


async def _suggest_memory(ctx: ToolContext, args: SuggestMemoryInput) -> str:
    from app.services.memory_suggest import looks_secret

    if looks_secret(args.content):
        raise ToolError("That looks like a secret (password, key or account number) and can't be stored as a memory.")
    try:
        await mem.create_memory(
            ctx.db, ctx.user_id, content=args.content, category=args.category, importance=args.importance,
            source="assistant", approved=False, source_conversation_id=ctx.conversation_id,
        )
    except mem.MemoryServiceError as exc:
        raise ToolError(exc.message) from exc
    return "Saved as a pending suggestion. It is NOT remembered yet: the user must approve it on the Memory page."


search_memories = Tool("search_memories", "Search the user's approved long-term memories. Use when the user asks what you know or remember about something, or when a saved preference or fact could change your answer and isn't already in the conversation.", SearchMemoriesInput, PermissionLevel.automatic, _search_memories, summarize=lambda a: a.query)
suggest_memory = Tool("suggest_memory", "Propose a long-term memory when the user asks you to remember something about them. It's stored as a pending suggestion that the user must approve; tell them so. Never store secrets.", SuggestMemoryInput, PermissionLevel.automatic, _suggest_memory, summarize=lambda a: a.content[:80])
