"""
Read-only fire and resolution endpoints for authenticated users.

Access is region-scoped: every request validates that the requesting user has
visibility over the fire's region via the ltree-based permission model.
Superusers and dispatchers with fires.history permission can query across all regions.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import storage
from ..auth.authen import current_active_user
from ..database import get_async_session
from ..database.models import (
    FieldOfficer,
    FireResolution,
    FireResolutionImage,
    Firespot,
    Region,
    User,
)
from ..db_control.fires import get_fires, get_resolution_history
from ..db_control.fire_export import build_history_zip, get_resolutions_for_export
from ..db_control.permission import fire_visible, has_perm_anywhere

router = APIRouter()


@router.get("")
async def list_fires(
    days: int | None = Query(None, ge=1, le=365),
    user: User = Depends(current_active_user),
):
    """
    Return fires visible to the current user.

    Visibility filtering is delegated entirely to `get_fires`, which applies
    the region-path permission model internally. Without ``days`` this keeps
    the short configured live-map window; dashboard reports may request a
    longer bounded rolling window.

    Args:
        days: Optional rolling window in calendar days (1-365).
        user: Authenticated user injected by FastAPI dependency.

    Returns:
        List of fire objects scoped to the user's assigned regions.
    """
    return await get_fires(user=user, display_days=days)


@router.get("/resolutions")
async def list_resolutions(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    false_alarm: bool | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    province: str | None = None,
    search: str | None = None,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    """
    Paginated history of resolved fires, gated by the fires.history permission.

    Args:
        limit:       Page size (1-100).
        offset:      Number of records to skip.
        false_alarm: Filter to true/false alarm resolutions only; None returns both.
        since:       Inclusive lower bound on resolution timestamp.
        until:       Exclusive upper bound on resolution timestamp.
        province:    Province code to narrow results to a single province.
        search:      Free-text substring match against fire name/location.
        user:        Authenticated user.
        session:     Async DB session.

    Returns:
        {"total": int, "items": [...]}

    Raises:
        HTTPException(403): User lacks fires.history permission in any assigned region.
    """
    if not await has_perm_anywhere(user, "fires.history", session):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "missing fires.history permission"
        )
    return await get_resolution_history(
        user=user,
        limit=limit,
        offset=offset,
        false_alarm=false_alarm,
        since=since,
        until=until,
        province=province,
        search=search,
    )


@router.get("/resolutions/export")
async def export_resolutions(
    false_alarm: bool | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    province: str | None = None,
    search: str | None = None,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    """Download resolved-fire history as a ZIP (history.csv + images folder tree).

    Accepts the same filters as `list_resolutions`; the dispatcher picks the date
    range via `since`/`until`. Gated by the same fires.history permission.

    Returns:
        application/zip attachment.

    Raises:
        HTTPException(403): User lacks fires.history permission in any assigned region.
    """
    if not await has_perm_anywhere(user, "fires.history", session):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "missing fires.history permission"
        )
    items = await get_resolutions_for_export(
        user=user,
        false_alarm=false_alarm,
        since=since,
        until=until,
        province=province,
        search=search,
    )
    data = await build_history_zip(items)
    fname = "fire-history"
    if since:
        fname += f"_{since:%Y%m%d}"
    if until:
        fname += f"_{until:%Y%m%d}"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}.zip"'},
    )


async def _visible_fire_or_404(
    fire_id: uuid.UUID, user: User, session: AsyncSession
) -> Firespot:
    """
    Fetch a Firespot by ID and assert the requesting user can see it.

    Combining existence and visibility checks into one helper keeps individual
    endpoints free of repeated guard logic. 404 is returned for missing fires
    and 403 for out-of-region fires — never the reverse — to avoid leaking
    whether an inaccessible fire exists.

    Args:
        fire_id: UUID of the target Firespot.
        user:    Requesting user.
        session: Active async DB session.

    Returns:
        The Firespot ORM object.

    Raises:
        HTTPException(404): Fire does not exist.
        HTTPException(403): Fire exists but is outside the user's region.
    """
    fire = await session.get(Firespot, fire_id)
    if fire is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "fire not found")
    region_path = (
        await session.execute(select(Region.path).where(Region.id == fire.region_id))
    ).scalar_one()
    if not await fire_visible(user, str(region_path), session):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "fire outside your assigned region"
        )
    return fire


@router.get("/{fire_id}/resolution")
async def get_fire_resolution(
    fire_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    """
    Return the resolution record for a specific fire, including officer name and image metadata.

    officer_name is fetched separately because the FieldOfficer record may have been
    deleted after the resolution was created. Returns None if the fire is unresolved.

    Args:
        fire_id: UUID of the target Firespot.
        user:    Authenticated user; must have visibility over the fire's region.
        session: Async DB session.

    Returns:
        Resolution dict with nested image metadata list, or None if unresolved.

    Raises:
        HTTPException(404/403): Via _visible_fire_or_404.
    """
    await _visible_fire_or_404(fire_id, user, session)
    resolution = (
        await session.execute(
            select(FireResolution).where(FireResolution.fire_id == fire_id)
        )
    ).scalar_one_or_none()
    if resolution is None:
        return None
    officer_name = None
    if resolution.officer_id is not None:
        officer_name = (
            await session.execute(
                select(FieldOfficer.name).where(
                    FieldOfficer.id == resolution.officer_id
                )
            )
        ).scalar_one_or_none()
    images = (
        (
            await session.execute(
                select(FireResolutionImage)
                .where(FireResolutionImage.resolution_id == resolution.id)
                .order_by(FireResolutionImage.created_at)
            )
        )
        .scalars()
        .all()
    )
    return {
        "id": str(resolution.id),
        "note": resolution.note,
        "officer_name": officer_name,
        "created_at": resolution.created_at.isoformat(),
        "images": [
            {
                "id": str(img.id),
                "content_type": img.content_type,
                "size_bytes": img.size_bytes,
                "latitude": img.latitude,
                "longitude": img.longitude,
            }
            for img in images
        ],
    }


@router.get("/{fire_id}/images/{image_id}")
async def get_fire_image(
    fire_id: uuid.UUID,
    image_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
):
    """
    Stream a resolution image binary from object storage.

    Access rule: a user may fetch the image if they have region visibility OR
    if they are the officer who uploaded it. The officer exception allows field
    officers to retrieve their own evidence even after a region reassignment.

    The response includes a 1-day private Cache-Control header so the client can
    avoid redundant fetches, while `private` prevents shared/proxy caching of evidence.

    Args:
        fire_id:  UUID of the parent Firespot (used to verify region).
        image_id: UUID of the FireResolutionImage to fetch.
        user:     Authenticated user.
        session:  Async DB session.

    Returns:
        Binary image response with the original content_type.

    Raises:
        HTTPException(404): Fire or image not found.
        HTTPException(403): User has no region access and is not the uploading officer.
        HTTPException(502): Object storage fetch failed.
    """
    fire = await session.get(Firespot, fire_id)
    if fire is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "fire not found")
    row = (
        await session.execute(
            select(FireResolutionImage, FireResolution.officer_id)
            .join(
                FireResolution, FireResolution.id == FireResolutionImage.resolution_id
            )
            .where(
                FireResolution.fire_id == fire_id, FireResolutionImage.id == image_id
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "image not found")
    image, officer_id = row
    region_path = (
        await session.execute(select(Region.path).where(Region.id == fire.region_id))
    ).scalar_one()
    if not await fire_visible(user, str(region_path), session):
        # Fallback: allow the officer who uploaded the image to retrieve their own evidence.
        my_officer_id = (
            await session.execute(
                select(FieldOfficer.id).where(FieldOfficer.user_id == user.id)
            )
        ).scalar_one_or_none()
        if my_officer_id != officer_id:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "fire outside your assigned region"
            )
    try:
        data = await storage.get_object(image.object_key)
    except Exception as exc:
        print(f"[fires] image fetch failed for {image.object_key}: {exc}")
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "evidence storage unavailable")
    return Response(
        content=data,
        media_type=image.content_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )
