from typing import Any
from uuid import UUID

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..database.models import Region, User, UserRegion


async def user_roles(user: User, session: AsyncSession) -> list[str]:
    """Return all role strings assigned to ``user`` across every region.

    Args:
        user:    The user whose roles are being queried.
        session: Active async SQLAlchemy session.

    Returns:
        List of role strings (e.g. ``["field_officer"]``). May contain duplicates
        if the user holds the same role in multiple regions.
    """
    result = await session.execute(
        select(UserRegion.role).where(UserRegion.user_id == user.id)
    )
    return [row[0] for row in result.all()]


# Permissions are split into view and action sets to enforce the principle that
# read access and write authority are granted independently.
VIEW_PERMS = frozenset(
    {
        "fires.view",
        "fires.history",
        "officers.view",
        "region_requests.view",
        "dispatchers.view",
    }
)
ACTION_PERMS = frozenset(
    {
        "officer.verify",
        "officer.manage",
        "fire.appoint",
        "fire.false",
        "region_request.decide",
        "dispatcher.manage",
    }
)
ALL_PERMISSIONS = VIEW_PERMS | ACTION_PERMS

# IMPLIES encodes permission dependencies so callers don't need to grant both
# a broad action perm and its narrower prerequisites explicitly.
# E.g. granting "fire.appoint" automatically implies "officers.view" and "fires.view".
IMPLIES = {
    "officer.verify": frozenset({"officers.view"}),
    "officer.manage": frozenset({"officers.view"}),
    "fire.appoint": frozenset({"officers.view", "fires.view"}),
    "fire.false": frozenset({"fires.view"}),
    "region_requests.view": frozenset({"officers.view"}),
    "region_request.decide": frozenset({"region_requests.view", "officers.view"}),
    "dispatcher.manage": frozenset({"dispatchers.view"}),
}

# Bundles for common admin roles; stored as a preset so new users can be onboarded
# quickly without manually assigning individual permissions.
PRESETS = {
    "dispatcher": frozenset(
        {
            "fires.view",
            "officers.view",
            "region_requests.view",
            "officer.verify",
            "officer.manage",
            "fire.appoint",
            "fire.false",
            "region_request.decide",
        }
    ),
    "admin": ALL_PERMISSIONS,
}

# Minimum guaranteed permissions per role, regardless of what is explicitly granted.
# Ensures a dispatcher can always see fires even if their permissions list is empty.
ROLE_FLOOR = {"dispatcher": frozenset({"fires.view"})}

# Officer-management action perms. Excludes dispatcher.manage (superuser-only) and
# fire.false, which is a fire-status override that must NOT confer officer-management
# authority — can_manage_officers gates the whole officer-management surface, so a
# dispatcher granted only fire.false must not pass it.
MANAGE_PERMS = ACTION_PERMS - frozenset({"dispatcher.manage", "fire.false"})

# Excludes management-scoped perms that should only be assigned by superusers.
GRANTABLE = ALL_PERMISSIONS - frozenset({"dispatcher.manage"})


def expand(perms) -> set[str]:
    """Flatten one level of permission implications.

    Iterates each granted permission and unions in its implied set from ``IMPLIES``.
    One pass is sufficient because no implied permission itself implies another.

    Args:
        perms: Iterable of explicitly granted permission strings.

    Returns:
        Expanded set including both explicit and implied permissions.
    """
    out = set(perms)
    for p in list(perms):
        out |= IMPLIES.get(p, frozenset())
    return out


def effective_perms(role: str, permissions) -> set[str]:
    """Resolve the complete permission set for a role+permissions pair.

    Resolution order:
    1. If ``permissions`` is None and the role has a preset, use the preset.
    2. Expand implied permissions.
    3. Union with the role's floor (guaranteed minimums).

    Args:
        role:        The user's role string (e.g. ``"dispatcher"``).
        permissions: Explicit permission list stored on the UserRegion row; may be None.

    Returns:
        Final effective permission set after implication and floor application.
    """
    if permissions is None and role in PRESETS:
        permissions = PRESETS[role]
    return expand(set(permissions or [])) | ROLE_FLOOR.get(role, frozenset())


async def _assignments(user: User, session: AsyncSession):
    """Fetch all (role, permissions) pairs for every region the user belongs to.

    Internal helper used by the permission-check functions to avoid duplicating
    the query across has_perm, user_permissions, etc.

    Returns:
        List of (role: str, permissions: list | None) tuples.
    """
    rows = await session.execute(
        select(UserRegion.role, UserRegion.permissions).where(
            UserRegion.user_id == user.id
        )
    )
    return rows.all()


async def has_perm(user: User, perm: str, path, session: AsyncSession) -> bool:
    """Check whether ``user`` holds ``perm`` in the region that contains ``path``.

    Uses the PostgreSQL ltree ``<@`` operator to find regions where the fire/entity
    path is a descendant of the user's assigned region.

    Args:
        user:    The user to check.
        perm:    Permission string to test (e.g. ``"fire.appoint"``).
        path:    ltree path of the resource being accessed.
        session: Active async SQLAlchemy session.

    Returns:
        ``True`` if the user has the permission in any matching region, or is a superuser.
    """
    if user.is_superuser:
        return True
    rows = await session.execute(
        text(
            "SELECT ur.role, ur.permissions FROM user_regions ur "
            "JOIN regions r ON r.id = ur.region_id "
            "WHERE ur.user_id = :uid AND CAST(:p AS ltree) <@ r.path"
        ).bindparams(uid=user.id, p=str(path))
    )
    return any(
        perm in effective_perms(role, permissions) for role, permissions in rows.all()
    )


async def has_perm_anywhere(user: User, perm: str, session: AsyncSession) -> bool:
    """Check whether ``user`` holds ``perm`` in at least one of their assigned regions.

    Used for UI-level feature gating (e.g. show/hide the dispatch button) where the
    specific resource path is not yet known.

    Args:
        user:    The user to check.
        perm:    Permission string to test.
        session: Active async SQLAlchemy session.

    Returns:
        ``True`` if the user has the permission in any region, or is a superuser.
    """
    if user.is_superuser:
        return True
    return any(
        perm in effective_perms(role, p)
        for role, p in await _assignments(user, session)
    )


async def user_permissions(user: User, session: AsyncSession) -> set[str]:
    """Return the union of all effective permissions across all of the user's regions.

    Args:
        user:    The user whose permissions are being resolved.
        session: Active async SQLAlchemy session.

    Returns:
        Set of all effective permission strings. Superusers receive ``ALL_PERMISSIONS``.
    """
    if user.is_superuser:
        return set(ALL_PERMISSIONS)
    out: set[str] = set()
    for role, p in await _assignments(user, session):
        out |= effective_perms(role, p)
    return out


async def is_admin_user(user: User, session: AsyncSession) -> bool:
    """Return ``True`` if the user has any non-empty effective permission set.

    Distinguishes admin-tier accounts (dispatchers, admins) from plain field officers
    who have no explicit permissions in the permission tables.

    Args:
        user:    The user to check.
        session: Active async SQLAlchemy session.
    """
    if user.is_superuser:
        return True
    return any(
        effective_perms(role, p) for role, p in await _assignments(user, session)
    )


async def can_manage_officers(user: User, session: AsyncSession) -> bool:
    """Return ``True`` if the user can perform any officer-management action.

    Args:
        user:    The user to check.
        session: Active async SQLAlchemy session.
    """
    if user.is_superuser:
        return True
    return any(
        effective_perms(role, p) & MANAGE_PERMS
        for role, p in await _assignments(user, session)
    )


async def is_field_officer(user: User, session: AsyncSession) -> bool:
    """Return ``True`` if the user holds the field_officer role in any region.

    Args:
        user:    The user to check.
        session: Active async SQLAlchemy session.
    """
    return "field_officer" in await user_roles(user, session)


async def user_region_paths(user: User, session: AsyncSession) -> list[str]:
    """Return the ltree paths of all regions directly assigned to ``user``.

    Callers must treat an empty return value as "no access" — NOT as "unrestricted".
    The superuser shortcut returns ``[]`` as a deliberate sentinel; callers must check
    ``user.is_superuser`` separately if they need to distinguish the two cases.

    Args:
        user:    The user whose assigned regions are being fetched.
        session: Active async SQLAlchemy session.

    Returns:
        List of ltree path strings. ``[]`` for superusers (treated as unrestricted by
        callers that already bypass via ``user.is_superuser``).
    """
    if user.is_superuser:
        return []
    result = await session.execute(
        select(Region.path)
        .join(UserRegion, UserRegion.region_id == Region.id)
        .where(UserRegion.user_id == user.id)
    )
    return [row[0] for row in result.all()]


async def fire_visible(user: User, fire_path: str, session: AsyncSession) -> bool:
    """Check whether a specific fire (identified by its region path) is visible to ``user``.

    Args:
        user:      The user requesting access.
        fire_path: ltree path of the fire's region.
        session:   Active async SQLAlchemy session.

    Returns:
        ``True`` if the fire falls within any of the user's assigned region subtrees.
    """
    if user.is_superuser:
        return True
    result = await session.execute(text("""
            SELECT 1
            FROM user_regions ur
            JOIN regions r ON r.id = ur.region_id
            WHERE ur.user_id = :uid AND CAST(:fire_path AS ltree) <@ r.path
            LIMIT 1
            """).bindparams(uid=user.id, fire_path=fire_path))
    return result.first() is not None


def filter_fires(
    user_paths: list[str], fires: list[dict], superuser: bool
) -> list[dict]:
    """In-memory region filter applied to WS-broadcast fire lists.

    Used instead of a DB re-query because the fire list is already loaded; this avoids
    a round-trip per connected WebSocket client on every broadcast event.

    Args:
        user_paths: List of ltree path strings the user is assigned to.
        fires:      Full list of fire dicts, each with a ``"path"`` key.
        superuser:  If ``True``, all fires are returned without filtering.

    Returns:
        Subset of ``fires`` whose path equals or is a descendant of any ``user_paths`` entry.
    """
    if superuser:
        return fires
    if not user_paths:
        return []
    # Pre-compute prefix strings to avoid re-appending "." in the inner loop.
    prefixes = [p + "." for p in user_paths]
    exact = set(user_paths)
    out = []
    for fire in fires:
        p = fire.get("path", "")
        if p in exact or any(p.startswith(pref) for pref in prefixes):
            out.append(fire)
    return out


async def update_user_region(
    session: AsyncSession,
    *,
    user_id: UUID,
    old_region_id: UUID,
    ur_obj: UserRegion,
    **values: Any,
) -> None:
    """Update a UserRegion row by PK without triggering SQLAlchemy identity-map conflicts.

    ``session.expunge`` is required because the ORM-tracked ``ur_obj`` instance and the
    ``update()`` statement would otherwise clash on the same identity, raising a
    ``StaleDataError`` or silently no-oping.

    Args:
        session:       Active async SQLAlchemy session.
        user_id:       FK component of the UserRegion composite PK.
        old_region_id: FK component of the UserRegion composite PK.
        ur_obj:        The tracked ORM instance to expunge before the raw UPDATE.
        **values:      Column key/value pairs to set on the row.
    """
    session.expunge(ur_obj)
    await session.execute(
        update(UserRegion)
        .where(UserRegion.user_id == user_id, UserRegion.region_id == old_region_id)
        .values(**values)
    )


if __name__ == "__main__":
    # Smoke-test the permission logic without a DB connection.
    assert effective_perms("dispatcher", []) == {"fires.view"}
    assert "fires.view" in effective_perms("dispatcher", None)
    assert "fires.view" in effective_perms("dispatcher", ["officers.view"])
    assert not (effective_perms("dispatcher", []) & MANAGE_PERMS)
    # fire.false ships in the dispatcher preset and is grantable...
    assert "fire.false" in PRESETS["dispatcher"]
    assert "fire.false" in GRANTABLE
    # ...and granting it implies fires.view but not officer-management authority.
    assert "fires.view" in effective_perms("dispatcher", ["fire.false"])
    assert "fire.false" not in MANAGE_PERMS
    assert not (effective_perms("dispatcher", ["fire.false"]) & MANAGE_PERMS)
    print("permission self-check ok")
