"""
Single WebSocket endpoint that multiplexes all real-time admin operations.

Architecture rationale: one persistent connection per admin client carries all
message types (officer management, dispatcher CRUD, fire re-sync). The `match`
dispatch table keeps routing logic flat and avoids a registry pattern for
what is a relatively small, stable set of message types.

Auth is resolved before `manager.connect` so the WS is never in a half-open
authenticated state; a policy violation closes the socket before any app logic runs.
"""

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth.ws_auth import get_user_from_ws
from ..database import async_session_maker
from ..db_control.permission import has_perm_anywhere, is_admin_user, user_region_paths
from ..ws.manager import manager
from ..ws.dispatcher_handlers import (
    handle_create_dispatcher,
    handle_delete_dispatcher,
    handle_list_dispatchers,
    handle_update_dispatcher,
)
from ..ws.fire_status import handle_cancel_false_fire, handle_false_fire
from ..ws.officers import (
    handle_appoint_officer,
    handle_cancel_booking,
    handle_decide_region_request,
    handle_delete_officer,
    handle_list_officers,
    handle_list_officers_MAP,
    handle_list_pending,
    handle_list_region_requests,
    handle_update_officer,
    handle_verify_officer,
)

router = APIRouter()
logger = logging.getLogger("firenet.ws")

# WebSocket close code 1008 = Policy Violation; used when auth fails pre-connect.
_WS_POLICY_VIOLATION = 1008


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """
    Admin WebSocket endpoint — authenticates, validates admin role, then dispatches messages.

    Connection lifecycle:
      1. Authenticate via token in headers/query; reject with 1008 if absent or invalid.
      2. Verify the user holds an admin role; reject with 1008 otherwise.
      3. Resolve region paths and officer-view permission once at connect time
         (cached for the lifetime of the connection).
      4. Enter receive loop; dispatch on `data["type"]`; log unknown types as warnings.
      5. On disconnect or any unexpected exception, unconditionally unregister the connection.

    The permission check uses a short-lived session that is closed before the long-lived
    receive loop begins — avoids holding a DB connection open for the entire session lifetime.

    Args:
        ws: The incoming WebSocket connection (FastAPI injects this).
    """
    user = await get_user_from_ws(ws)
    if user is None:
        await ws.close(code=_WS_POLICY_VIOLATION)
        return
    async with async_session_maker() as session:
        if not await is_admin_user(user, session):
            await ws.close(code=_WS_POLICY_VIOLATION)
            return
        # Resolve once; handlers receive these as arguments rather than re-querying.
        paths = await user_region_paths(user, session)
        can_view_officers = await has_perm_anywhere(user, "officers.view", session)
    conn = await manager.connect(ws, user, paths, can_view_officers)
    try:
        while True:
            try:
                data = await ws.receive_json()
            except ValueError:
                # Malformed JSON: notify client and continue — don't drop the connection.
                await ws.send_json({"type": "error", "code": "invalid_json"})
                continue
            match data.get("type"):
                case "list_pending_officers":
                    await handle_list_pending(ws, user)
                case "verify_officer":
                    await handle_verify_officer(ws, user, data, manager.active)
                case "list_region_requests":
                    await handle_list_region_requests(ws, user)
                case "decide_region_request":
                    await handle_decide_region_request(ws, user, data, manager.active)
                case "update_officer":
                    await handle_update_officer(ws, user, data, manager.active)
                case "delete_officer":
                    await handle_delete_officer(ws, user, data, manager.active)
                case "appoint_officer":
                    await handle_appoint_officer(ws, user, data, manager.active)
                case "cancel_booking":
                    await handle_cancel_booking(ws, user, data, manager.active)
                case "false_fire":
                    await handle_false_fire(ws, user, data)
                case "cancel_false_fire":
                    await handle_cancel_false_fire(ws, user, data)
                case "list_dispatchers":
                    await handle_list_dispatchers(ws, user)
                case "create_dispatcher":
                    await handle_create_dispatcher(ws, user, data)
                case "update_dispatcher":
                    await handle_update_dispatcher(ws, user, data)
                case "delete_dispatcher":
                    await handle_delete_dispatcher(ws, user, data)
                case "list_officers":
                    await handle_list_officers(ws, user)
                case "list_officers_MAP":
                    await handle_list_officers_MAP(ws, user)
                case "resync_fires":
                    # Client requests a full fire-state snapshot (e.g. after reconnect).
                    await manager.send_snapshot(conn)
                case _:
                    logger.warning(
                        "ws user=%s unknown message type=%s", user.id, data.get("type")
                    )
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("ws user=%s error: %s", user.id, exc)
    finally:
        manager.disconnect(ws)
