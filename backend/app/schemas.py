"""Pydantic request/response schemas for the HTTP API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import MessageRole, MessageStatus


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Auth -------------------------------------------------------------------


class AuthStatus(BaseModel):
    setup_required: bool
    setup_token_required: bool


class UserOut(ORMModel):
    id: str
    username: str
    display_name: str
    created_at: datetime


_USERNAME_PATTERN = r"^[A-Za-z0-9_.\-]{3,64}$"


class SetupRequest(BaseModel):
    username: str = Field(pattern=_USERNAME_PATTERN)
    password: str = Field(min_length=1, max_length=256)
    display_name: str = Field(default="", max_length=128)
    setup_token: str | None = None


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class LoginResponse(BaseModel):
    token: str
    expires_at: datetime
    user: UserOut


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class UpdateProfileRequest(BaseModel):
    display_name: str = Field(max_length=128)


# --- Conversations ------------------------------------------------------------


class MessageOut(ORMModel):
    id: str
    seq: int
    role: MessageRole
    content: str
    status: MessageStatus
    model: str | None
    error: str | None
    created_at: datetime


class ConversationSummary(ORMModel):
    id: str
    title: str
    pinned: bool
    created_at: datetime
    updated_at: datetime
    message_count: int = 0
    preview: str = ""


class ConversationDetail(ORMModel):
    id: str
    title: str
    pinned: bool
    created_at: datetime
    updated_at: datetime
    messages: list[MessageOut]


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)


class ConversationUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    pinned: bool | None = None

    @field_validator("title")
    @classmethod
    def strip_title(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("title cannot be blank")
        return v


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)

    @field_validator("content")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message cannot be blank")
        return v


# --- Settings -----------------------------------------------------------------


Effort = Literal["", "low", "medium", "high", "xhigh", "max"]
_MODEL_PATTERN = r"^$|^[a-z0-9][a-z0-9.\-]{2,99}$"


class UserPreferences(BaseModel):
    """User-adjustable preferences persisted in app_settings. All fields optional on update."""

    assistant_name: str = Field(default="JARVIS", min_length=1, max_length=40)
    model: str = Field(default="", max_length=100, pattern=_MODEL_PATTERN)  # "" = server default
    max_output_tokens: int = Field(default=0, ge=0, le=128_000)  # 0 = server default
    effort: Effort = ""  # "" = the model's default effort
    voice_input_enabled: bool = True
    speak_responses: bool = False
    voice_name: str = Field(default="", max_length=200)
    speech_rate: float = Field(default=1.0, ge=0.5, le=2.0)
    send_on_enter: bool = True


class UserPreferencesUpdate(BaseModel):
    assistant_name: str | None = Field(default=None, min_length=1, max_length=40)
    model: str | None = Field(default=None, max_length=100, pattern=_MODEL_PATTERN)
    max_output_tokens: int | None = Field(default=None, ge=0, le=128_000)
    effort: Effort | None = None
    voice_input_enabled: bool | None = None
    speak_responses: bool | None = None
    voice_name: str | None = Field(default=None, max_length=200)
    speech_rate: float | None = Field(default=None, ge=0.5, le=2.0)
    send_on_enter: bool | None = None


class SettingsOut(BaseModel):
    preferences: UserPreferences
    server: "ServerInfo"


class ModelOption(BaseModel):
    id: str
    label: str
    description: str
    input_per_mtok: float
    output_per_mtok: float


class ServerInfo(BaseModel):
    version: str
    phase: int
    ai_provider: Literal["claude", "unconfigured"]
    ai_configured: bool
    default_model: str
    default_max_output_tokens: int
    refusal_fallback: bool
    models: list[ModelOption]


SettingsOut.model_rebuild()


class BackupOut(BaseModel):
    filename: str
    size_bytes: int
    created_at: datetime


class UsageRow(BaseModel):
    model: str
    requests: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    estimated_cost_usd: float | None


class UsageSummary(BaseModel):
    days: int
    totals: UsageRow
    by_model: list[UsageRow]
