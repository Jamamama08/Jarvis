"""Permission engine.

Each tool has a level: automatic, restricted or sensitive. The user's policy for a
call is the first match of: a per-tool rule ("tool:<name>"), a per-level rule
("level:<level>"), then the default. Defaults: automatic -> allow; restricted and
sensitive -> ask. Sensitive tools can never be set to allow: they always need an
explicit approval (or are denied).
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Permission, PermissionDecision, PermissionLevel
from app.tools.base import Tool

DEFAULTS: dict[PermissionLevel, PermissionDecision] = {
    PermissionLevel.automatic: PermissionDecision.allow,
    PermissionLevel.restricted: PermissionDecision.ask,
    PermissionLevel.sensitive: PermissionDecision.ask,
}


class PolicyError(ValueError):
    pass


def tool_scope(name: str) -> str:
    return f"tool:{name}"


def level_scope(level: PermissionLevel) -> str:
    return f"level:{level.value}"


async def load_policies(db: AsyncSession, user_id: str) -> dict[str, PermissionDecision]:
    rows = (await db.execute(select(Permission).where(Permission.user_id == user_id))).scalars()
    return {row.scope: row.decision for row in rows}


def resolve(tool: Tool, policies: dict[str, PermissionDecision]) -> PermissionDecision:
    decision = policies.get(tool_scope(tool.name)) or policies.get(level_scope(tool.level)) or DEFAULTS[tool.level]
    if tool.level == PermissionLevel.sensitive and decision == PermissionDecision.allow:
        decision = PermissionDecision.ask  # defence in depth; set_policy refuses this anyway
    return decision


async def decide(db: AsyncSession, user_id: str, tool: Tool) -> PermissionDecision:
    return resolve(tool, await load_policies(db, user_id))


async def set_policy(
    db: AsyncSession, user_id: str, scope: str, decision: PermissionDecision | None, *, level: PermissionLevel
) -> None:
    """Set (or clear, with decision=None) a rule. `level` is the level the scope refers to."""
    if decision == PermissionDecision.allow and level == PermissionLevel.sensitive:
        raise PolicyError("Sensitive actions always need your approval; they can't be set to run automatically.")
    existing = (
        await db.execute(select(Permission).where(Permission.user_id == user_id, Permission.scope == scope))
    ).scalar_one_or_none()
    if decision is None:
        if existing:
            await db.delete(existing)
    elif existing:
        existing.decision = decision
    else:
        db.add(Permission(user_id=user_id, scope=scope, decision=decision))
