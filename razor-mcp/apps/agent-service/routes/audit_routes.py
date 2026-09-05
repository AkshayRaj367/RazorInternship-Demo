"""GET /api/audit/<sessionId> — the server-side hydration fallback for the
timeline (the primary path is ws-gateway's audit:backlog on room join).

v2: when a Bearer JWT is presented, only that room's audit entries are
returned (agentId == user:<uid>); unauthenticated callers see only legacy
demo-agent entries for the session.
"""
from flask import Blueprint, jsonify, request

from services import transaction_service
from services import auth_service
from services.audit_service import get_timeline

audit_bp = Blueprint("audit", __name__, url_prefix="/api/audit")


@audit_bp.get("/<session_id>")
def timeline(session_id: str):
    if not transaction_service.SESSION_ID_RE.match(session_id):
        return jsonify({"error": "INVALID_SESSION_ID"}), 400

    agent_filter = None
    try:
        user = auth_service.user_from_token(request.headers.get("Authorization"))
        agent_filter = auth_service.room_agent_id(user)
    except auth_service.AuthError:
        pass  # legacy demo mode — no room pinning

    return jsonify({"sessionId": session_id, "events": get_timeline(session_id, agent_id=agent_filter)})
