"""Authentication: first-run account setup, login/logout, profile and password."""

import ipaddress
import secrets
import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import delete, func, select

from app.api.deps import AppSettings, CurrentSession, CurrentUser, DbSession
from app.core.security import hash_password, hash_token, new_session_token, verify_password
from app.models import AuthSession, User
from app.schemas import (
    AuthStatus,
    ChangePasswordRequest,
    LoginRequest,
    LoginResponse,
    SetupRequest,
    UpdateProfileRequest,
    UserOut,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRateLimiter:
    """Simple in-memory sliding-window limiter for failed logins, keyed by client IP."""

    def __init__(self, max_failures: int = 5, window_seconds: int = 300):
        self.max_failures = max_failures
        self.window = window_seconds
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, key: str) -> deque[float]:
        q = self._failures[key]
        cutoff = time.monotonic() - self.window
        while q and q[0] < cutoff:
            q.popleft()
        return q

    def check(self, key: str) -> None:
        if len(self._prune(key)) >= self.max_failures:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many failed login attempts. Try again later.")

    def fail(self, key: str) -> None:
        self._prune(key).append(time.monotonic())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


def _is_loopback(host: str) -> bool:
    if host in ("localhost",):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _setup_token_required(settings) -> bool:
    """Exposed (non-loopback) servers must be claimed with JARVIS_SETUP_TOKEN."""
    return not _is_loopback(settings.host)


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def _user_count(db) -> int:
    return (await db.execute(select(func.count()).select_from(User))).scalar_one()


async def _issue_session(db, user: User, request: Request, settings) -> LoginResponse:
    token = new_session_token()
    expires = datetime.now(UTC) + timedelta(hours=settings.session_ttl_hours)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            expires_at=expires,
            user_agent=(request.headers.get("user-agent") or "")[:255],
        )
    )
    # Opportunistically purge expired sessions.
    await db.execute(delete(AuthSession).where(AuthSession.expires_at <= datetime.now(UTC)))
    await db.commit()
    return LoginResponse(token=token, expires_at=expires, user=UserOut.model_validate(user))


@router.get("/status", response_model=AuthStatus)
async def auth_status(db: DbSession, settings: AppSettings) -> AuthStatus:
    return AuthStatus(
        setup_required=await _user_count(db) == 0,
        setup_token_required=_setup_token_required(settings),
    )


@router.post("/setup", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
async def setup(body: SetupRequest, request: Request, db: DbSession, settings: AppSettings) -> LoginResponse:
    if await _user_count(db) > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Setup has already been completed")
    if _setup_token_required(settings):
        expected = settings.setup_token.get_secret_value() if settings.setup_token else None
        if not expected:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Server is network-exposed; set JARVIS_SETUP_TOKEN to allow first-run setup",
            )
        if not body.setup_token or not secrets.compare_digest(body.setup_token, expected):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid setup token")
    if len(body.password) < settings.min_password_length:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Password must be at least {settings.min_password_length} characters",
        )
    user = User(
        username=body.username.lower(),
        display_name=body.display_name.strip() or body.username,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    await db.flush()
    return await _issue_session(db, user, request, settings)


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, request: Request, db: DbSession, settings: AppSettings) -> LoginResponse:
    limiter: LoginRateLimiter = request.app.state.login_limiter
    key = _client_key(request)
    limiter.check(key)
    user = (await db.execute(select(User).where(User.username == body.username.lower()))).scalar_one_or_none()
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        limiter.fail(key)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")
    limiter.reset(key)
    return await _issue_session(db, user, request, settings)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(session: CurrentSession, db: DbSession) -> None:
    await db.delete(session)
    await db.commit()


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


@router.patch("/me", response_model=UserOut)
async def update_me(body: UpdateProfileRequest, user: CurrentUser, db: DbSession) -> User:
    user.display_name = body.display_name.strip() or user.username
    await db.commit()
    return user


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: ChangePasswordRequest, user: CurrentUser, session: CurrentSession, db: DbSession, settings: AppSettings
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    if len(body.new_password) < settings.min_password_length:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Password must be at least {settings.min_password_length} characters",
        )
    user.password_hash = hash_password(body.new_password)
    # Revoke every other session for this user.
    await db.execute(delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.id != session.id))
    await db.commit()
