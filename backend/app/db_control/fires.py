"""Fire read model: serialisation, lifecycle jobs, and region-scoped queries.

Ingest lives in `firefetch.py`; the history export lives in `fire_export.py`.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Any, TypedDict
from zoneinfo import ZoneInfo

from geoalchemy2.shape import to_shape
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import aliased

from .. import storage
from ..config import get_settings
from ..database import async_session_maker
from ..database.models.fire_resolution import FireResolution, FireResolutionImage
from ..database.models.field_officer import FieldOfficer
from ..database.models.firespot import Firespot
from ..database.models.region import Region
from ..database.models.user import User
from .audit import audit


class FireDetail(TypedDict):
    """Typed contract for the serialised fire payload returned to API/WS consumers."""

    id: str
    name: str | None
    detected_at: str
    status: bool
    expired: bool
    false_alarm: bool
    booked: bool        # True when a field officer has claimed this fire
    appointed: bool     # True when the officer has been formally dispatched
    lat: float
    lng: float
    tumboon: str | None
    aumper: str | None
    province: str | None
    type: str | None
    satellite: str | None


def build_fire_detail(
    fire: Firespot, booked: bool = True, appointed: bool = False
) -> FireDetail:
    """Serialise a Firespot ORM row into a flat dict safe for JSON transport.

    Args:
        fire:      SQLAlchemy Firespot instance with a PostGIS ``location`` column.
        booked:    Whether a field officer holds this fire (caller resolves this).
        appointed: Whether the officer has been formally dispatched.

    Returns:
        FireDetail dict with geometry unpacked to ``lat``/``lng`` floats.

    Warning:
        ``fire.detail`` may be None if the external source omitted the field;
        the ``or {}`` guard prevents key errors on the subsequent ``.get()`` calls.
    """
    pt = to_shape(fire.location)  # convert PostGIS WKB → Shapely Point
    detail = fire.detail or {}
    return {
        "id": str(fire.id),
        "name": fire.name,
        "detected_at": fire.detected_at.isoformat(),
        "status": fire.status,
        "expired": fire.expired,
        "false_alarm": fire.false_alarm,
        "booked": booked,
        "appointed": appointed,
        "lat": pt.y,   # Shapely Point: x=lng, y=lat
        "lng": pt.x,
        "tumboon": detail.get("TUMBON"),
        "aumper": detail.get("AUMPER"),
        "province": detail.get("PROVINCE"),
        "type": detail.get("NAME"),
        "satellite": detail.get("SATELLITE"),
    }


# Module-level singleton — avoids reconstructing ZoneInfo on every ingest cycle.
_INGEST_TZ = ZoneInfo(get_settings().INGEST_TIMEZONE)


async def expire_old_fires() -> None:
    """Mark long-unresolved fires as expired and unlink their assigned officers.

    Expiration threshold is controlled by ``FIRE_EXPIRE_DAYS`` in settings.
    Officer records are unlinked so they become available for new assignments;
    the officer row itself is kept for historical reference.
    """
    cutoff = datetime.now(_INGEST_TZ).replace(tzinfo=timezone.utc) - timedelta(
        days=get_settings().FIRE_EXPIRE_DAYS
    )
    async with async_session_maker() as session:
        expired_ids = (
            (
                await session.execute(
                    update(Firespot)
                    # Only expire fires that are still open (status=False)
                    .where(Firespot.status == False, Firespot.detected_at < cutoff)
                    .values(status=True, expired=True, resolve_time=func.now())
                    .returning(Firespot.id)
                )
            )
            .scalars()
            .all()
        )
        if expired_ids:
            await session.execute(
                update(FieldOfficer)
                .where(FieldOfficer.fire_id.in_(expired_ids))
                .values(fire_id=None)
            )
            # Record a resolution row for each expired fire so it surfaces in the
            # resolution history/export alongside officer-resolved and false-alarm
            # closures. Auto-closure has no acting officer, so officer_id/officer_name
            # stay null; the firespot's ``expired`` flag is what the UI badges. Guard
            # against a pre-existing row (e.g. a fire reopened via false-cancel then
            # left to expire) to respect the one-resolution-per-fire unique constraint.
            already = set(
                (
                    await session.execute(
                        select(FireResolution.fire_id).where(
                            FireResolution.fire_id.in_(expired_ids)
                        )
                    )
                )
                .scalars()
                .all()
            )
            session.add_all(
                FireResolution(fire_id=fid, officer_id=None, officer_name=None)
                for fid in expired_ids
                if fid not in already
            )
            audit(
                session,
                actor=None,
                action="fire.expire",
                entity_type="fire",
                detail={"count": len(expired_ids)},
            )
            print(f"[expire_old_fires] expired={len(expired_ids)}")
        await session.commit()


async def sweep_orphan_images() -> None:
    """Remove storage objects uploaded for resolutions that were never committed to DB.

    Targets yesterday's resolution prefix only to avoid scanning the full bucket and
    to allow a small grace window for in-flight uploads. Runs as a nightly maintenance
    task to reclaim storage after partial failure scenarios (e.g. upload succeeded but
    subsequent DB write failed).
    """
    day = f"{datetime.now(timezone.utc) - timedelta(days=1):%Y%m%d}"
    keys = await storage.list_keys(f"resolutions/{day}/")
    if not keys:
        return
    async with async_session_maker() as session:
        known = (
            (
                await session.execute(
                    select(FireResolutionImage.object_key).where(
                        FireResolutionImage.object_key.in_(keys)
                    )
                )
            )
            .scalars()
            .all()
        )
    orphans = sorted(set(keys) - set(known))
    if orphans:
        await storage.remove_objects(orphans)
        print(f"[sweep_orphan_images] removed={len(orphans)}")


async def get_fires(
    region_path: str | None = None,
    status: bool | None = None,
    on_date: date | None = None,
    user: User | None = None,
    display_days: int | None = None,
) -> list[dict[str, Any]]:
    """Query firespots with optional region, status, and date filters.

    Non-superusers are restricted to fires within their assigned region subtrees
    (using the PostgreSQL ltree ``<@`` descendant operator). Additionally, if an
    officer personally holds a fire outside their usual region, it is included.

    Args:
        region_path: ltree path prefix; matches the region and all its descendants.
        status:      ``False`` = active, ``True`` = resolved; ``None`` = both.
        on_date:     Return fires detected on this specific date. If ``None``, returns
                     the rolling window defined by ``FIRE_DISPLAY_DAYS`` in settings.
        user:        Requesting user; ``None`` means an internal/trusted call (no ACL).
        display_days: Optional rolling-window override for HTTP reporting requests.
                      ``None`` preserves the configured live-map window.

    Returns:
        List of serialised fire dicts ordered by ``detected_at`` descending.
    """
    from .permission import user_region_paths

    async with async_session_maker() as session:
        # Two officer aliases are needed: one for the current holder, one for the
        # officer referenced in the resolution record (may differ if reassigned).
        ResolverOfficer = aliased(FieldOfficer)
        stmt = (
            select(
                Firespot.id,
                Firespot.external_id,
                Firespot.name,
                Firespot.detail,
                Firespot.detected_at,
                Firespot.status,
                Firespot.expired,
                Firespot.false_alarm,
                Firespot.resolve_time,
                Firespot.location,
                Region.path.label("region_path"),
                FieldOfficer.id.label("holder_id"),
                FieldOfficer.name.label("holder_name"),
                FieldOfficer.appointed.label("holder_appointed"),
                ResolverOfficer.name.label("resolver_name"),
                FireResolution.officer_name.label("resolution_officer_name"),
            )
            .join(Region, Firespot.region_id == Region.id)
            .outerjoin(FieldOfficer, FieldOfficer.fire_id == Firespot.id)
            .outerjoin(FireResolution, FireResolution.fire_id == Firespot.id)
            .outerjoin(ResolverOfficer, ResolverOfficer.id == FireResolution.officer_id)
        )

        if region_path is not None:
            # <@ = "is descendant of or equal to" in PostgreSQL ltree
            stmt = stmt.where(Region.path.op("<@")(region_path))
        if status is not None:
            stmt = stmt.where(Firespot.status == status)
        if on_date is not None:
            stmt = stmt.where(func.date(Firespot.detected_at) == on_date)
        else:
            # Default rolling window: today back N days (midnight-aligned in ingest TZ).
            days = max(
                display_days
                if display_days is not None
                else get_settings().FIRE_DISPLAY_DAYS,
                1,
            )
            today_start = datetime.now(_INGEST_TZ).replace(
                hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc
            )
            window_start = today_start - timedelta(days=days - 1)
            stmt = stmt.where(Firespot.detected_at >= window_start)
        if user is not None and not user.is_superuser:
            paths = await user_region_paths(user, session)
            conds = [Region.path.op("<@")(p) for p in paths]
            # An officer may hold a fire that falls outside their home region
            # (e.g. cross-border assignment); always include it.
            held = (
                await session.execute(
                    select(FieldOfficer.fire_id).where(
                        FieldOfficer.user_id == user.id,
                        FieldOfficer.fire_id.isnot(None),
                    )
                )
            ).scalar_one_or_none()
            if held is not None:
                conds.append(Firespot.id == held)
            if not conds:
                return []
            stmt = stmt.where(or_(*conds))
        stmt = stmt.order_by(Firespot.detected_at.desc())
        rows = await session.execute(stmt)
        rows = rows.all()
        print(f"[get_fires] on_date={on_date} rows={len(rows)}")

        result = []
        for row in rows:
            pt = to_shape(row.location)
            detail = row.detail or {}
            result.append(
                {
                    "id": str(row.id),
                    "name": row.name,
                    "detected_at": row.detected_at.isoformat(),
                    "resolve_time": (
                        row.resolve_time.isoformat() if row.resolve_time else None
                    ),
                    "status": row.status,
                    "expired": row.expired,
                    "false_alarm": row.false_alarm,
                    "booked": row.holder_id is not None,
                    "appointed": bool(row.holder_appointed),
                    "holder_id": str(row.holder_id) if row.holder_id else None,
                    # Resolution officer name falls back through two sources in case the
                    # FieldOfficer row was deleted after resolution.
                    "holder_name": row.holder_name
                    or row.resolver_name
                    or row.resolution_officer_name,
                    "lat": pt.y,
                    "lng": pt.x,
                    "path": row.region_path,
                    "tumboon": detail.get("TUMBON"),
                    "aumper": detail.get("AUMPER"),
                    "province": detail.get("PROVINCE"),
                    "type": detail.get("NAME"),
                    "satellite": detail.get("SATELLITE"),
                }
            )
        return result


async def get_resolution_history(
    user: User | None = None,
    limit: int = 20,
    offset: int = 0,
    false_alarm: bool | None = None,
    expired: bool | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    province: str | None = None,
    search: str | None = None,
    officer_id: Any = None,
) -> dict[str, Any]:
    """Return a paginated list of resolved fires with their resolution metadata.

    ``officer_id`` bypasses the user-region ACL so an officer can query their own
    history regardless of region assignments (used for self-service history view).

    Args:
        user:       Requesting user for region-scoped ACL; ``None`` = unrestricted.
        limit:      Page size.
        offset:     Page start index.
        false_alarm: Filter to confirmed false alarms or real fires; ``None`` = both.
        expired:    Filter to auto-expired (timed-out) closures or not; ``None`` = both.
        since/until: Inclusive/exclusive bounds on ``FireResolution.created_at``.
        province:   Exact Thai province name filter against JSONB ``detail`` field.
        search:     Case-insensitive substring matched across name, officer, location fields.
        officer_id: If set, return only resolutions where this officer was the resolver.

    Returns:
        ``{"total": int, "items": [...]}`` — total is the unpagedcount for UI pagination.
    """
    from .permission import user_region_paths

    async with async_session_maker() as session:
        stmt = (
            select(
                Firespot.id,
                Firespot.name,
                Firespot.detail,
                Firespot.detected_at,
                Firespot.false_alarm,
                Firespot.expired,
                FireResolution.id.label("resolution_id"),
                FireResolution.note,
                FireResolution.created_at.label("resolved_at"),
                # Prefer the live officer name; fall back to the snapshot stored at
                # resolution time in case the officer record was later deleted.
                func.coalesce(FieldOfficer.name, FireResolution.officer_name).label(
                    "officer_name"
                ),
            )
            .join(Region, Firespot.region_id == Region.id)
            .join(FireResolution, FireResolution.fire_id == Firespot.id)
            .outerjoin(FieldOfficer, FieldOfficer.id == FireResolution.officer_id)
        )
        # officer_id overrides region ACL — the officer is fetching their own records.
        if user is not None and not user.is_superuser and officer_id is None:
            paths = await user_region_paths(user, session)
            if not paths:
                return {"items": [], "total": 0}
            stmt = stmt.where(or_(*[Region.path.op("<@")(p) for p in paths]))
        if false_alarm is not None:
            stmt = stmt.where(Firespot.false_alarm == false_alarm)
        if expired is not None:
            stmt = stmt.where(Firespot.expired == expired)
        if province:
            # JSONB path extraction (.astext) for equality avoids casting issues.
            stmt = stmt.where(Firespot.detail["PROVINCE"].astext == province)
        if search:
            like = f"%{search}%"
            stmt = stmt.where(
                or_(
                    Firespot.name.ilike(like),
                    func.coalesce(FieldOfficer.name, FireResolution.officer_name).ilike(
                        like
                    ),
                    Firespot.detail["TUMBON"].astext.ilike(like),
                    Firespot.detail["AUMPER"].astext.ilike(like),
                    Firespot.detail["PROVINCE"].astext.ilike(like),
                )
            )
        if officer_id is not None:
            stmt = stmt.where(FireResolution.officer_id == officer_id)
        if since is not None:
            stmt = stmt.where(FireResolution.created_at >= since)
        if until is not None:
            stmt = stmt.where(FireResolution.created_at < until)
        # Count against the filtered subquery before applying limit/offset.
        total = (
            await session.execute(select(func.count()).select_from(stmt.subquery()))
        ).scalar_one()
        rows = (
            await session.execute(
                stmt.order_by(FireResolution.created_at.desc())
                .limit(limit)
                .offset(offset)
            )
        ).all()

        # Fetch all image IDs for the current page in one query to avoid N+1.
        imgs: dict = {}
        res_ids = [r.resolution_id for r in rows]
        if res_ids:
            for img in (
                await session.execute(
                    select(
                        FireResolutionImage.id,
                        FireResolutionImage.resolution_id,
                        FireResolutionImage.content_type,
                    )
                    .where(FireResolutionImage.resolution_id.in_(res_ids))
                    .order_by(FireResolutionImage.created_at)
                )
            ).all():
                imgs.setdefault(img.resolution_id, []).append(
                    {"id": str(img.id), "content_type": img.content_type}
                )
        return {
            "total": total,
            "items": [
                {
                    "fire_id": str(r.id),
                    "name": r.name,
                    "tumboon": (r.detail or {}).get("TUMBON"),
                    "aumper": (r.detail or {}).get("AUMPER"),
                    "province": (r.detail or {}).get("PROVINCE"),
                    "detected_at": r.detected_at.isoformat(),
                    "resolved_at": r.resolved_at.isoformat(),
                    "officer_name": r.officer_name,
                    "note": r.note,
                    "false_alarm": r.false_alarm,
                    "expired": r.expired,
                    "images": imgs.get(r.resolution_id, []),
                }
                for r in rows
            ],
        }
