"""Internal HTTP client -> ws-gateway POST /internal/emit.

Flask NEVER talks Socket.IO directly. Every realtime event (audit steps, OTP
prompts, recovery links) is POSTed here with the X-Internal-Secret shared
secret, and ws-gateway relays it into the Socket.IO room keyed by sessionId.

Emission is fire-and-forget on purpose: a ws-gateway blip must never fail a
business transaction. The audit log insert itself is the source of truth; the
socket push is delivery optimization.
"""
import requests

from config import config


def emit_to_room(session_id: str, event: str, payload: dict) -> bool:
    if not session_id:
        return False
    try:
        resp = requests.post(
            f"{config.WS_GATEWAY_URL.rstrip('/')}/internal/emit",
            json={"room": session_id, "event": event, "payload": payload},
            headers={"X-Internal-Secret": config.INTERNAL_WS_SECRET},
            timeout=5,
        )
        return resp.status_code == 202
    except requests.RequestException as err:
        print(f"[ws_client] emit failed ({event} -> room {session_id}): {err}")
        return False
