"""Memory management and project endpoints."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models import Conversation, Memory, MemoryCategory, MemoryHistory, Project
from app.schemas import (
    MemoryCreate,
    MemoryHistoryOut,
    MemoryList,
    MemoryOut,
    MemorySuggestions,
    MemoryUpdate,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)
from app.services import memory as mem
from app.services.memory_suggest import suggest_memories as suggest
from app.services.preferences import load_preferences
from app.services.providers import ClaudeProvider, ProviderError

router = APIRouter(prefix="/api", tags=["memory"])


def _conflict(exc: mem.MemoryServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status, content={"detail": exc.message, "existing_id": exc.existing_id}
    )


async def _owned_memory(db, user_id: str, memory_id: str) -> Memory:
    memory = await db.get(Memory, memory_id)
    if memory is None or memory.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
    return memory


@router.get("/memories", response_model=MemoryList)
async def list_memories(
    user: CurrentUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=500),
    category: MemoryCategory | None = None,
    state: Literal["approved", "pending", "all"] = "approved",
    project_id: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> MemoryList:
    stmt = select(Memory).where(Memory.user_id == user.id)
    if state != "all":
        stmt = stmt.where(Memory.approved.is_(state == "approved"))
    if category:
        stmt = stmt.where(Memory.category == category)
    if project_id:
        stmt = stmt.where(Memory.project_id == project_id)

    ranked: list[str] | None = None
    if q and q.strip():
        query = mem.fts_query(q, mode="all")
        ranked = await mem.fts_ids(db, user.id, query, approved=None, limit=1000) if query else []
        stmt = stmt.where(Memory.id.in_(ranked))

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    if ranked is not None:
        rows = list((await db.execute(stmt)).scalars())
        order = {mid: i for i, mid in enumerate(ranked)}
        rows.sort(key=lambda m: order.get(m.id, 0))
        rows = rows[offset : offset + limit]
    else:
        stmt = stmt.order_by(Memory.importance.desc(), Memory.updated_at.desc()).limit(limit).offset(offset)
        rows = list((await db.execute(stmt)).scalars())
    return MemoryList(
        items=[MemoryOut.model_validate(m) for m in rows], total=total, counts=await mem.category_counts(db, user.id)
    )


@router.post("/memories", response_model=MemoryOut, status_code=status.HTTP_201_CREATED)
async def create_memory(body: MemoryCreate, user: CurrentUser, db: DbSession):
    try:
        memory = await mem.create_memory(
            db,
            user.id,
            content=body.content,
            category=body.category,
            importance=body.importance,
            project_id=body.project_id,
            allow_near_duplicate=body.allow_near_duplicate,
        )
    except mem.MemoryServiceError as exc:
        return _conflict(exc)
    await db.commit()
    return MemoryOut.model_validate(memory)


@router.get("/memories/history", response_model=list[MemoryHistoryOut])
async def recent_history(user: CurrentUser, db: DbSession, limit: int = Query(default=50, ge=1, le=500)):
    rows = await db.execute(
        select(MemoryHistory)
        .where(MemoryHistory.user_id == user.id)
        .order_by(MemoryHistory.created_at.desc())
        .limit(limit)
    )
    return list(rows.scalars())


@router.get("/memories/{memory_id}", response_model=MemoryOut)
async def get_memory(memory_id: str, user: CurrentUser, db: DbSession):
    return await _owned_memory(db, user.id, memory_id)


@router.patch("/memories/{memory_id}", response_model=MemoryOut)
async def update_memory(memory_id: str, body: MemoryUpdate, user: CurrentUser, db: DbSession):
    memory = await _owned_memory(db, user.id, memory_id)
    try:
        await mem.update_memory(
            db, memory, body.model_dump(exclude_unset=True), allow_near_duplicate=body.allow_near_duplicate
        )
    except mem.MemoryServiceError as exc:
        return _conflict(exc)
    await db.commit()
    return MemoryOut.model_validate(memory)


@router.post("/memories/{memory_id}/approve", response_model=MemoryOut)
async def approve_memory(memory_id: str, user: CurrentUser, db: DbSession):
    memory = await _owned_memory(db, user.id, memory_id)
    await mem.approve_memory(db, memory)
    await db.commit()
    return MemoryOut.model_validate(memory)


@router.post("/memories/{memory_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
async def reject_memory(memory_id: str, user: CurrentUser, db: DbSession) -> None:
    memory = await _owned_memory(db, user.id, memory_id)
    if memory.approved:
        raise HTTPException(status.HTTP_409_CONFLICT, "Only pending suggestions can be rejected; delete it instead")
    await mem.delete_memory(db, memory, action="reject")
    await db.commit()


@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_memory(
    memory_id: str,
    user: CurrentUser,
    db: DbSession,
    purge_history: bool = Query(default=False, description="Also erase this memory's change history"),
) -> None:
    memory = await _owned_memory(db, user.id, memory_id)
    await mem.delete_memory(db, memory, purge_history=purge_history)
    await db.commit()


@router.get("/memories/{memory_id}/history", response_model=list[MemoryHistoryOut])
async def memory_history(memory_id: str, user: CurrentUser, db: DbSession):
    rows = await db.execute(
        select(MemoryHistory)
        .where(MemoryHistory.user_id == user.id, MemoryHistory.memory_id == memory_id)
        .order_by(MemoryHistory.created_at.desc())
    )
    items = list(rows.scalars())
    if not items:
        await _owned_memory(db, user.id, memory_id)  # 404 unless it exists with no history
    return items


# --- Projects -----------------------------------------------------------------


async def _owned_project(db, user_id: str, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if project is None or project.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    return project


async def _project_out(db, project: Project) -> ProjectOut:
    count = (await db.execute(select(func.count()).where(Memory.project_id == project.id))).scalar_one()
    return ProjectOut.model_validate(project).model_copy(update={"memory_count": count})


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(user: CurrentUser, db: DbSession):
    projects = (
        await db.execute(select(Project).where(Project.user_id == user.id).order_by(Project.updated_at.desc()))
    ).scalars()
    return [await _project_out(db, p) for p in projects]


@router.post("/projects", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(body: ProjectCreate, user: CurrentUser, db: DbSession):
    project = Project(user_id=user.id, **body.model_dump())
    project.name = project.name.strip()
    db.add(project)
    await db.commit()
    return await _project_out(db, project)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
async def update_project(project_id: str, body: ProjectUpdate, user: CurrentUser, db: DbSession):
    project = await _owned_project(db, user.id, project_id)
    for field, value in body.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(project, field, value.strip() if field == "name" else value)
    await db.commit()
    return await _project_out(db, project)


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: str, user: CurrentUser, db: DbSession) -> None:
    """Deletes the project; its memories are kept and simply unlinked."""
    project = await _owned_project(db, user.id, project_id)
    await db.delete(project)
    await db.commit()


# --- Suggestions --------------------------------------------------------------


@router.post("/conversations/{conversation_id}/suggest-memories", response_model=MemorySuggestions)
async def suggest_memories(conversation_id: str, request: Request, user: CurrentUser, db: DbSession):
    """Ask Claude to propose memories from this conversation. They are saved as pending suggestions."""
    conversation = await db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    provider = request.app.state.provider
    if not isinstance(provider, ClaudeProvider):
        raise HTTPException(status.HTTP_409_CONFLICT, "Claude is not connected, so it can't suggest memories.")
    prefs = await load_preferences(db, user.id)
    try:
        created, skipped = await suggest(
            db, provider, user_id=user.id, conversation=conversation,
            model=prefs.model or request.app.state.settings.default_model,
        )
    except ProviderError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.user_message) from exc
    return MemorySuggestions(created=[MemoryOut.model_validate(m) for m in created], skipped_duplicates=skipped)
