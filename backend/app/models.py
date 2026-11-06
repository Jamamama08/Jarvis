"""Database models.

Every table required by the project spec is defined here so the schema is stable
from Phase 1. Tables that are used by later phases (memories, tasks, tool
executions, ...) are created now but only populated once their phase lands.
"""

from __future__ import annotations

import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid.uuid4().hex


class TZDateTime(TypeDecorator):
    """DateTime that always round-trips as timezone-aware UTC (SQLite drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(UTC)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class MessageRole(enum.StrEnum):
    user = "user"
    assistant = "assistant"
    system = "system"


class MessageStatus(enum.StrEnum):
    complete = "complete"
    streaming = "streaming"
    cancelled = "cancelled"
    error = "error"


class MemoryCategory(enum.StrEnum):
    preference = "preference"
    personal = "personal"
    project = "project"
    progress = "progress"
    knowledge = "knowledge"
    conversation = "conversation"


class TaskStatus(enum.StrEnum):
    pending = "pending"
    running = "running"
    waiting_approval = "waiting_approval"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class PermissionLevel(enum.StrEnum):
    automatic = "automatic"
    restricted = "restricted"
    sensitive = "sensitive"


class PermissionDecision(enum.StrEnum):
    allow = "allow"
    ask = "ask"
    deny = "deny"


class ToolExecutionStatus(enum.StrEnum):
    pending_approval = "pending_approval"
    approved = "approved"
    denied = "denied"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


def _enum(e: type[enum.Enum]) -> Enum:
    return Enum(e, native_enum=False, length=32, validate_strings=True)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


# ---------------------------------------------------------------------------
# Users & auth
# ---------------------------------------------------------------------------


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    sessions: Mapped[list[AuthSession]] = relationship(back_populates="user", cascade="all, delete-orphan")
    conversations: Mapped[list[Conversation]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AuthSession(Base):
    """Login session. Only a SHA-256 hash of the bearer token is stored."""

    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    last_used_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)
    user_agent: Mapped[str] = mapped_column(String(255), default="", nullable=False)

    user: Mapped[User] = relationship(back_populates="sessions")


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------


class Conversation(TimestampMixin, Base):
    __tablename__ = "conversations"
    __table_args__ = (Index("ix_conversations_user_updated", "user_id", "updated_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="New conversation")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)

    user: Mapped[User] = relationship(back_populates="conversations")
    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", order_by="Message.seq"
    )


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (UniqueConstraint("conversation_id", "seq", name="uq_messages_conversation_seq"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[MessageRole] = mapped_column(_enum(MessageRole), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[MessageStatus] = mapped_column(
        _enum(MessageStatus), nullable=False, default=MessageStatus.complete
    )
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Extra structured data. For user messages: {"memory_context": str, "memory_ids": [...]},
    # the memory context sent with this turn (stored so replayed history stays identical).
    blocks: Mapped[dict | list | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")

    @property
    def memory_ids(self) -> list[str]:
        """IDs of approved memories attached to this (user) message as context."""
        if isinstance(self.blocks, dict):
            ids = self.blocks.get("memory_ids")
            if isinstance(ids, list):
                return [str(i) for i in ids]
        return []


# ---------------------------------------------------------------------------
# Memory, projects, tasks (populated from Phases 3 / 7)
# ---------------------------------------------------------------------------


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    progress_notes: Mapped[str] = mapped_column(Text, nullable=False, default="")


class Memory(TimestampMixin, Base):
    __tablename__ = "memories"
    __table_args__ = (UniqueConstraint("user_id", "content_hash", name="uq_memories_user_hash"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category: Mapped[MemoryCategory] = mapped_column(_enum(MemoryCategory), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # Normalised-content hash, used to prevent duplicate memories.
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    source_conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    approved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    importance: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    # "user" = written by the user; "assistant" = suggested by Claude (pending until approved).
    source: Mapped[str] = mapped_column(String(16), nullable=False, default="user", server_default="user")
    last_used_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


class MemoryHistory(Base):
    """Append-only audit trail of memory changes (create/update/delete)."""

    __tablename__ = "memory_history"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    memory_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    old_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[TaskStatus] = mapped_column(_enum(TaskStatus), nullable=False, default=TaskStatus.pending)
    plan: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


# ---------------------------------------------------------------------------
# Tools & permissions (Phase 5)
# ---------------------------------------------------------------------------


class ToolExecution(Base):
    __tablename__ = "tool_executions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    tool_name: Mapped[str] = mapped_column(String(100), nullable=False)
    permission_level: Mapped[PermissionLevel] = mapped_column(_enum(PermissionLevel), nullable=False)
    status: Mapped[ToolExecutionStatus] = mapped_column(_enum(ToolExecutionStatus), nullable=False)
    # Inputs/outputs are stored after secret redaction.
    input: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    output: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)


class Permission(TimestampMixin, Base):
    """Per-user policy for a tool or permission level (allow / ask / deny)."""

    __tablename__ = "permissions"
    __table_args__ = (UniqueConstraint("user_id", "scope", name="uq_permissions_user_scope"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # "level:restricted" or "tool:file_writer"
    scope: Mapped[str] = mapped_column(String(120), nullable=False)
    decision: Mapped[PermissionDecision] = mapped_column(_enum(PermissionDecision), nullable=False)


# ---------------------------------------------------------------------------
# Settings & usage
# ---------------------------------------------------------------------------


class AppSetting(Base):
    __tablename__ = "app_settings"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_app_settings_user_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(String(100), nullable=False)
    value: Mapped[object] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, onupdate=utcnow, nullable=False)


class ApiUsage(Base):
    __tablename__ = "api_usage"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    message_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow, nullable=False)
