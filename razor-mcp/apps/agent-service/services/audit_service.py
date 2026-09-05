"""Audit trail writer — the RazorSense timeline's server side.

Every decision the system makes lands here and is pushed to the browser
IMMEDIATELY (no batching) via ws_client -> ws-gateway -> room sessionId.
No TTL: audit_logs is the durable trail.
"""
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

import db
from ws_client import emit_to_room

AUDIT_STEPS = (
    "INTENT",
    "INVENTORY_LOCK",
    "GUARDRAIL_PASS",
    "GUARDRAIL_OTP_REQUIRED",
    "OTP_VERIFIED",
    "OTP_AUTO_APPROVED",
    "ORDER_GENERATED",
    "PAYMENT_FAILED",
    "RECOVERY_INITIATED",
    "RECOVERY_LINK_SENT",
    "ORDER_COMPLETED",
    "ORDER_CANCELLED",
    "WEB_PRODUCT_SEARCH",
    "BYOK_PAYMENT_PENDING",
    "BYOK_PAYMENT_CAPTURED",
)


def room_for(session_id: str, agent_id: str) -> str:
    """v2 rooms: authed accounts (agent_id 'user:<uid>') get a prefixed room so
    only JWT-holders can join; legacy demo agents keep the bare sessionId room."""
    if agent_id.startswith("user:"):
        return f"{agent_id}:{session_id}"
    return session_id


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def serialize(doc: dict) -> dict:
    """Mongo-safe -> JSON-safe (ObjectId -> str, datetime -> ISO)."""
    out = dict(doc)
    for key, value in out.items():
        if isinstance(value, ObjectId):
            out[key] = str(value)
        elif isinstance(value, datetime):
            out[key] = value.isoformat()
    return out


def log_step(
    session_id: str,
    agent_id: str,
    step: str,
    detail: dict[str, Any] | None = None,
    order_id: ObjectId | str | None = None,
) -> dict:
    """Insert one audit entry and push it to the room immediately.

    Returns the serialized entry (safe to embed in API responses).
    """
    if step not in AUDIT_STEPS:
        raise ValueError(f"UNKNOWN_AUDIT_STEP: {step}")

    doc = {
        "sessionId": session_id,
        "agentId": agent_id,
        "orderId": ObjectId(order_id) if isinstance(order_id, str) else order_id,
        "step": step,
        "detail": detail or {},
        "timestamp": _utcnow(),
    }
    result = db.audit_logs().insert_one(doc)
    doc["_id"] = result.inserted_id

    entry = serialize(doc)
    # Push immediately — the frontend timeline renders this as a live step.
    emit_to_room(room_for(session_id, agent_id), "audit:event", {"sessionId": session_id, "entry": entry})
    return entry


def get_timeline(session_id: str, limit: int = 1000, agent_id: str | None = None) -> list[dict]:
    """Ascending timeline for hydration/fallback reads (GET /api/audit/:sessionId).

    When agent_id (authed room) is given, only that room's entries are returned.
    """
    query: dict[str, Any] = {"sessionId": session_id}
    if agent_id is not None:
        query["agentId"] = agent_id
    cursor = (
        db.audit_logs()
        .find(query)
        .sort([("timestamp", 1), ("_id", 1)])
        .limit(limit)
    )
    return [serialize(d) for d in cursor]
