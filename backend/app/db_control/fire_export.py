"""Resolved-fire history export: unpaginated query + CSV/ZIP assembly.

Consumed by router/fires.py to serve the dispatcher's history download
(history.csv + an images/<month>/<day>/<fire>/<n>.<ext> folder tree).
"""

import csv
import io
import re
import zipfile
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select

from .. import storage
from ..config import get_settings
from ..database import async_session_maker
from ..database.models.fire_resolution import FireResolution, FireResolutionImage
from ..database.models.field_officer import FieldOfficer
from ..database.models.firespot import Firespot
from ..database.models.region import Region
from ..database.models.user import User

# Local copy so this module doesn't reach back into fires.py for a constant.
_INGEST_TZ = ZoneInfo(get_settings().INGEST_TIMEZONE)

# Windows/most-filesystem reserved characters; collapse them so a fire name can
# always be used as a folder segment inside the export ZIP.
_UNSAFE_PATH = re.compile(r'[/\\:*?"<>|]+')


def _safe_name(name: str | None) -> str:
    """Turn a fire display name into a single safe path segment."""
    cleaned = _UNSAFE_PATH.sub("_", (name or "unnamed").strip())
    return cleaned or "unnamed"


def _history_csv(items: list[dict[str, Any]]) -> bytes:
    """Render export rows as CSV bytes, UTF-8 with BOM so Excel reads Thai correctly."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        ["ดับเมื่อ", "พบเมื่อ", "จุดไฟ", "ตำบล", "อำเภอ", "จังหวัด",
         "ดับโดย", "ผลลัพธ์", "หมายเหตุ", "จำนวนรูป"]
    )
    for it in items:
        w.writerow([
            it["resolved_at"].astimezone(_INGEST_TZ).strftime("%Y-%m-%d %H:%M"),
            it["detected_at"].astimezone(_INGEST_TZ).strftime("%Y-%m-%d %H:%M"),
            it["name"] or "",
            it["tumboon"] or "",
            it["aumper"] or "",
            it["province"] or "",
            it["officer_name"] or "",
            "หมดอายุ" if it["expired"] else ("ไม่ใช่ไฟ" if it["false_alarm"] else "ดับแล้ว"),
            it["note"] or "",
            len(it["images"]),
        ])
    return buf.getvalue().encode("utf-8-sig")


async def get_resolutions_for_export(
    user: User | None = None,
    false_alarm: bool | None = None,
    expired: bool | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    province: str | None = None,
    search: str | None = None,
) -> list[dict[str, Any]]:
    """Unpaginated resolution rows for the ZIP export, with image object keys.

    Same filters and region ACL as `get_resolution_history`, but returns every
    matching row (no limit/offset) and each image's storage `object_key` +
    `content_type` so the caller can bundle the binaries.
    """
    from .permission import user_region_paths

    async with async_session_maker() as session:
        stmt = (
            select(
                Firespot.name,
                Firespot.detail,
                Firespot.detected_at,
                Firespot.false_alarm,
                Firespot.expired,
                FireResolution.id.label("resolution_id"),
                FireResolution.note,
                FireResolution.created_at.label("resolved_at"),
                func.coalesce(FieldOfficer.name, FireResolution.officer_name).label(
                    "officer_name"
                ),
            )
            .join(Region, Firespot.region_id == Region.id)
            .join(FireResolution, FireResolution.fire_id == Firespot.id)
            .outerjoin(FieldOfficer, FieldOfficer.id == FireResolution.officer_id)
        )
        if user is not None and not user.is_superuser:
            paths = await user_region_paths(user, session)
            if not paths:
                return []
            stmt = stmt.where(or_(*[Region.path.op("<@")(p) for p in paths]))
        if false_alarm is not None:
            stmt = stmt.where(Firespot.false_alarm == false_alarm)
        if expired is not None:
            stmt = stmt.where(Firespot.expired == expired)
        if province:
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
        if since is not None:
            stmt = stmt.where(FireResolution.created_at >= since)
        if until is not None:
            stmt = stmt.where(FireResolution.created_at < until)
        rows = (
            await session.execute(stmt.order_by(FireResolution.created_at.desc()))
        ).all()

        imgs: dict = {}
        res_ids = [r.resolution_id for r in rows]
        if res_ids:
            for img in (
                await session.execute(
                    select(
                        FireResolutionImage.resolution_id,
                        FireResolutionImage.object_key,
                        FireResolutionImage.content_type,
                    )
                    .where(FireResolutionImage.resolution_id.in_(res_ids))
                    .order_by(FireResolutionImage.created_at)
                )
            ).all():
                imgs.setdefault(img.resolution_id, []).append(
                    (img.object_key, img.content_type)
                )
        return [
            {
                "name": r.name,
                "tumboon": (r.detail or {}).get("TUMBON"),
                "aumper": (r.detail or {}).get("AUMPER"),
                "province": (r.detail or {}).get("PROVINCE"),
                "detected_at": r.detected_at,
                "resolved_at": r.resolved_at,
                "officer_name": r.officer_name,
                "note": r.note,
                "false_alarm": r.false_alarm,
                "expired": r.expired,
                "images": imgs.get(r.resolution_id, []),
            }
            for r in rows
        ]


async def build_history_zip(items: list[dict[str, Any]]) -> bytes:
    """Assemble the export ZIP: history.csv plus images/<month>/<day>/<fire>/<n>.<ext>.

    Images are bucketed by *resolved* date (local ingest TZ), matching the date
    range the dispatcher selected.
    """
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("history.csv", _history_csv(items))
        for it in items:
            local = it["resolved_at"].astimezone(_INGEST_TZ)\
            # quick note: if you want to bucket by detected date instead, swap the above line to:
            # local = it["resolved_at"].astimezone(_INGEST_TZ)
            folder = (
                f"images/{local:%Y-%m}/{local:%Y-%m-%d}/{_safe_name(it['name'])}"
            )
            for idx, (object_key, content_type) in enumerate(it["images"], start=1):
                try:
                    data = await storage.get_object(object_key)
                except Exception as exc:
                    print(f"[export] skipped image {object_key}: {exc}")
                    continue
                ext = storage.IMAGE_EXT.get(content_type) or storage.VIDEO_EXT.get(content_type, "jpg")
                zf.writestr(f"{folder}/{idx}.{ext}", data)
    return out.getvalue()
