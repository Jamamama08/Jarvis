"""Conversation and message endpoints."""

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession
from app.models import Conversation, Message, ToolExecution
from app.schemas import (
    ConversationCreate,
    ConversationDetail,
    ConversationSummary,
    ConversationUpdate,
    MessageCreate,
    ToolExecutionOut,
)
from app.tools.executor import to_out
from app.services.chat import DEFAULT_TITLE, run_turn

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


async def _get_owned(db, user_id: str, conversation_id: str, *, with_messages: bool = False) -> Conversation:
    stmt = select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id)
    if with_messages:
        stmt = stmt.options(selectinload(Conversation.messages))
    conversation = (await db.execute(stmt)).scalar_one_or_none()
    if conversation is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
    return conversation


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(
    user: CurrentUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[ConversationSummary]:
    count_sq = (
        select(Message.conversation_id, func.count(Message.id).label("n"))
        .group_by(Message.conversation_id)
        .subquery()
    )
    last_seq_sq = (
        select(Message.conversation_id, func.max(Message.seq).label("max_seq"))
        .group_by(Message.conversation_id)
        .subquery()
    )
    stmt = (
        select(Conversation, func.coalesce(count_sq.c.n, 0), Message.content)
        .outerjoin(count_sq, count_sq.c.conversation_id == Conversation.id)
        .outerjoin(last_seq_sq, last_seq_sq.c.conversation_id == Conversation.id)
        .outerjoin(
            Message, (Message.conversation_id == Conversation.id) & (Message.seq == last_seq_sq.c.max_seq)
        )
        .where(Conversation.user_id == user.id, Conversation.archived.is_(False))
        .order_by(Conversation.pinned.desc(), Conversation.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if q and q.strip():
        like = f"%{q.strip()}%"
        matching = select(Message.conversation_id).where(Message.content.ilike(like))
        stmt = stmt.where(or_(Conversation.title.ilike(like), Conversation.id.in_(matching)))
    rows = (await db.execute(stmt)).all()
    return [
        ConversationSummary(
            id=c.id,
            title=c.title,
            pinned=c.pinned,
            created_at=c.created_at,
            updated_at=c.updated_at,
            message_count=n,
            preview=" ".join((preview or "").split())[:140],
        )
        for c, n, preview in rows
    ]


@router.post("", response_model=ConversationDetail, status_code=status.HTTP_201_CREATED)
async def create_conversation(body: ConversationCreate, user: CurrentUser, db: DbSession) -> ConversationDetail:
    title = (body.title or "").strip() or DEFAULT_TITLE
    conversation = Conversation(user_id=user.id, title=title)
    db.add(conversation)
    await db.commit()
    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        pinned=conversation.pinned,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        messages=[],
    )


@router.get("/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(conversation_id: str, user: CurrentUser, db: DbSession) -> ConversationDetail:
    conversation = await _get_owned(db, user.id, conversation_id, with_messages=True)
    detail = ConversationDetail.model_validate(conversation)
    executions = (
        await db.execute(
            select(ToolExecution)
            .where(ToolExecution.conversation_id == conversation_id, ToolExecution.user_id == user.id)
            .order_by(ToolExecution.created_at)
        )
    ).scalars()
    by_message: dict[str, list] = {}
    for ex in executions:
        if ex.message_id:
            by_message.setdefault(ex.message_id, []).append(ToolExecutionOut.model_validate(to_out(ex, summary=(ex.input or {}).get("_summary", ""))))
    for message in detail.messages:
        message.tools = by_message.get(message.id, [])
    return detail


@router.patch("/{conversation_id}", response_model=ConversationSummary)
async def update_conversation(
    conversation_id: str, body: ConversationUpdate, user: CurrentUser, db: DbSession
) -> ConversationSummary:
    conversation = await _get_owned(db, user.id, conversation_id)
    if body.title is not None:
        conversation.title = body.title
    if body.pinned is not None:
        conversation.pinned = body.pinned
    await db.commit()
    count = (
        await db.execute(select(func.count(Message.id)).where(Message.conversation_id == conversation.id))
    ).scalar_one()
    return ConversationSummary(
        id=conversation.id,
        title=conversation.title,
        pinned=conversation.pinned,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        message_count=count,
    )


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str, request: Request, user: CurrentUser, db: DbSession) -> None:
    conversation = await _get_owned(db, user.id, conversation_id)
    request.app.state.generations.cancel(conversation_id)
    await db.delete(conversation)
    await db.commit()


@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str, body: MessageCreate, request: Request, user: CurrentUser, db: DbSession
) -> StreamingResponse:
    await _get_owned(db, user.id, conversation_id)
    registry = request.app.state.generations
    try:
        cancel_event = registry.start(conversation_id)
    except RuntimeError:
        raise HTTPException(status.HTTP_409_CONFLICT, "A response is already being generated for this conversation")
    stream = run_turn(
        sessionmaker=request.app.state.db.sessionmaker,
        settings=request.app.state.settings,
        provider=request.app.state.provider,
        registry=registry,
        cancel_event=cancel_event,
        user_id=user.id,
        conversation_id=conversation_id,
        content=body.content,
        tools=request.app.state.tools,
        approvals=request.app.state.approvals,
        services=request.app.state.tool_services,
    )
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{conversation_id}/cancel")
async def cancel_generation(conversation_id: str, request: Request, user: CurrentUser, db: DbSession) -> dict:
    await _get_owned(db, user.id, conversation_id)
    return {"cancelled": request.app.state.generations.cancel(conversation_id)}
