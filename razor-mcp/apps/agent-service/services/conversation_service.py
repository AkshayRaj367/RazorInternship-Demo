"""Isolated per-room conversation history for Onyx (agent_conversations).

Memory-bounding patch: every append uses $push with $each + $slice: -20, ONE
atomic operation that caps the array at its most recent 20 entries. History can
never grow unbounded no matter how long a session lives, and each session's
timeline is isolated (unique sessionId) — one session's messages are never
visible to another.

v2: authed rooms stamp userId on the doc and history reads filter by it, so
even a leaked sessionId cannot resurrect another account's transcript.
"""
from datetime import datetime, timezone
from typing import Any

import db

MAX_HISTORY = 20


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _serialize(msg: dict[str, Any]) -> dict[str, Any]:
    out = dict(msg)
    ts = out.get("timestamp")
    if isinstance(ts, datetime):
        out["timestamp"] = ts.isoformat()
    return out


def get_history(session_id: str, agent_id: str | None = None) -> list[dict[str, Any]]:
    """Load this session's capped history (creating the doc lazily is unnecessary).

    When agent_id (an authed room, user:<uid>) is given, the doc must ALSO belong
    to that room — defense in depth against cross-room reads.
    """
    query: dict[str, Any] = {"sessionId": session_id}
    if agent_id is not None:
        query["agentId"] = agent_id
    doc = db.agent_conversations().find_one(query)
    if doc is None:
        return []
    return [_serialize(m) for m in doc.get("messages", [])]


def append_message(
    session_id: str,
    agent_id: str,
    role: str,
    content: str,
    tool_name: str | None = None,
    tool_args: Any = None,
) -> None:
    """Append ONE message, atomically capped to the last MAX_HISTORY entries.

    $push + $each + $slice: -20 is a single server-side operation: the array is
    trimmed in the same write that appends — there is no window where history
    exceeds the cap, and no client-side trimming that could race.
    """
    msg: dict[str, Any] = {
        "role": role,
        "content": content,
        "timestamp": _utcnow(),
    }
    if tool_name:
        msg["toolName"] = tool_name
    if tool_args is not None:
        msg["toolArgs"] = tool_args

    now = _utcnow()
    db.agent_conversations().update_one(
        {"sessionId": session_id},
        {
            "$push": {"messages": {"$each": [msg], "$slice": -MAX_HISTORY}},
            "$setOnInsert": {"agentId": agent_id, "createdAt": now},
            "$set": {"updatedAt": now},
        },
        upsert=True,
    )


def append_messages(session_id: str, agent_id: str, messages: list[dict[str, Any]]) -> None:
    """Persist a batch of exchanged messages (each already role/content shaped)."""
    for m in messages:
        append_message(
            session_id,
            agent_id,
            m.get("role", "assistant"),
            m.get("content", ""),
            m.get("toolName"),
            m.get("toolArgs"),
        )


def clear_history(session_id: str) -> None:
    db.agent_conversations().delete_one({"sessionId": session_id})
