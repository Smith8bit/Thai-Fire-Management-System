"""WS handlers for admin/dispatcher-initiated fire-status overrides.

The officer-facing `/officers/me/fire/false-report` HTTP endpoint lets the officer
who *holds* a fire close it as a false alarm. These handlers give a dispatcher the
same outcome from the console without holding the fire: anyone with the region-scoped
`fire.false` permission can mark a fire in their area as a false alarm — releasing any
officer currently assigned to it — and reverse that decision ("cancel false fire").

Marking false mirrors the officer flow: it writes a FireResolution row (so the closure
shows in resolution history/export, attributed to the acting dispatcher) and flips the
firespot to closed+false_alarm. Cancelling deletes that resolution and reopens the fire.
A false report never carries image evidence in either flow, so deleting the resolution
row leaves no orphaned storage objects to clean up.

All writes to `firespots` fire the Postgres NOTIFY trigger (see pg_listener.py), so the
updated fire is broadcast to every connected client automatically; the direct reply here
is only an ack for the initiating socket.
"""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import WebSocket
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from ..config import get_settings
from ..database import async_session_maker
from ..database.models import (
    FieldOfficer,
    FireResolution,
    Firespot,
    Region,
    User,
    UserRegion,
)
from ..db_control.audit import audit
from ..db_control.permission import has_perm

logger = logging.getLogger("firenet.fire_status")
settings = get_settings()


async def _fire_with_path(session, fire_id: uuid.UUID):
    """Load a firespot and its region ltree path in one place.

    Returns ``(fire, path)`` or ``(None, None)`` when the fire doesn't exist.
    """
    fire = await session.get(Firespot, fire_id)
    if fire is None:
        return None, None
    path = (
        await session.execute(select(Region.path).where(Region.id == fire.region_id))
    ).scalar_one()
    return fire, path


async def _actor_display_name(session, user: User) -> str:
    """Resolve the acting dispatcher's display name for the resolution record.

    Uses the shallowest (broadest-jurisdiction) UserRegion name, matching how
    /users/me/profile derives ``name``; falls back to the login email so the
    audit trail is never blank.
    """
    name = (
        await session.execute(
            select(UserRegion.name)
            .join(Region, Region.id == UserRegion.region_id)
            .where(UserRegion.user_id == user.id)
            .order_by(func.nlevel(Region.path))
            .limit(1)
        )
    ).scalar_one_or_none()
    return name or user.email


async def handle_false_fire(ws: WebSocket, user: User, data: dict) -> None:
    """Mark an open fire as a false alarm on the dispatcher's authority.

    Args:
        ws: The acting user's socket.
        user: Must hold "fire.false" scoped to the fire's region.
        data: Expects {"fire_id": <uuid str>} with an optional "note".

    Edge cases:
        - Fire missing -> "fire_not_found".
        - Fire already closed (resolved / expired / already false) -> "fire_resolved".
        - An officer currently holding the fire is released so they're free again.
    """
    try:
        fire_id = uuid.UUID(data["fire_id"])
    except (KeyError, ValueError):
        await ws.send_json({"type": "error", "code": "invalid_request"})
        return
    note = data.get("note")
    if isinstance(note, str):
        note = note.strip() or None
        if note is not None and len(note) > settings.RESOLVE_NOTE_MAX_CHARS:
            await ws.send_json({"type": "error", "code": "note_too_long"})
            return
    else:
        note = None

    async with async_session_maker() as session:
        fire, fire_path = await _fire_with_path(session, fire_id)
        if fire is None:
            await ws.send_json({"type": "error", "code": "fire_not_found"})
            return
        if not await has_perm(user, "fire.false", fire_path, session):
            await ws.send_json({"type": "error", "code": "forbidden"})
            return
        if fire.status:
            # Already closed by some path; refuse rather than silently re-closing.
            await ws.send_json({"type": "error", "code": "fire_resolved"})
            return
        # Release any officer holding this fire so they become available again.
        await session.execute(
            update(FieldOfficer)
            .where(FieldOfficer.fire_id == fire_id)
            .values(fire_id=None, appointed=False)
        )
        actor_name = await _actor_display_name(session, user)
        # Only one resolution row is allowed per fire (unique fire_id); an open fire
        # normally has none, but guard against a stale row to avoid an IntegrityError.
        existing = (
            await session.execute(
                select(FireResolution.id).where(FireResolution.fire_id == fire_id)
            )
        ).scalar_one_or_none()
        if existing is None:
            session.add(
                FireResolution(
                    fire_id=fire.id,
                    officer_id=None,
                    officer_name=actor_name,
                    note=note,
                )
            )
        fire.status = True
        fire.false_alarm = True
        fire.resolve_time = datetime.now(timezone.utc)
        audit(
            session,
            actor=user,
            action="fire.false_report",
            entity_type="fire",
            entity_id=str(fire_id),
            detail={"name": fire.name, "by": "dispatcher"},
        )
        try:
            await session.commit()
        except IntegrityError:
            # Race: another actor closed this fire (and wrote its unique
            # resolution row) between our status check and commit.
            await session.rollback()
            await ws.send_json({"type": "error", "code": "fire_resolved"})
            return
    logger.info("fire marked false fire=%s by user=%s", fire_id, user.id)
    await ws.send_json({"type": "fire_false_marked", "fire_id": str(fire_id)})


async def handle_cancel_false_fire(ws: WebSocket, user: User, data: dict) -> None:
    """Reverse a false-alarm marking, reopening the fire.

    Args:
        ws: The acting user's socket.
        user: Must hold "fire.false" scoped to the fire's region.
        data: Expects {"fire_id": <uuid str>}.

    Edge cases:
        - Fire missing -> "fire_not_found".
        - Fire isn't a false alarm -> "not_false_alarm" (never touches genuine
          photo-backed resolutions or still-open fires).
    """
    try:
        fire_id = uuid.UUID(data["fire_id"])
    except (KeyError, ValueError):
        await ws.send_json({"type": "error", "code": "invalid_request"})
        return
    async with async_session_maker() as session:
        fire, fire_path = await _fire_with_path(session, fire_id)
        if fire is None:
            await ws.send_json({"type": "error", "code": "fire_not_found"})
            return
        if not await has_perm(user, "fire.false", fire_path, session):
            await ws.send_json({"type": "error", "code": "forbidden"})
            return
        if not fire.false_alarm:
            await ws.send_json({"type": "error", "code": "not_false_alarm"})
            return
        # Drop the resolution record (false reports carry no image evidence, so
        # there are no storage objects to reclaim). CASCADE clears any image rows.
        await session.execute(
            delete(FireResolution).where(FireResolution.fire_id == fire_id)
        )
        fire.status = False
        fire.false_alarm = False
        fire.expired = False
        fire.resolve_time = None
        audit(
            session,
            actor=user,
            action="fire.false_cancel",
            entity_type="fire",
            entity_id=str(fire_id),
            detail={"name": fire.name},
        )
        await session.commit()
    logger.info("false marking cancelled fire=%s by user=%s", fire_id, user.id)
    await ws.send_json({"type": "fire_false_cancelled", "fire_id": str(fire_id)})
