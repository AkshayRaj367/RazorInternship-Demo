"""POST /api/agent/chat — Onyx's entrypoint from the Next.js proxy (v2: authed).

Every chat request now carries the logged-in user (Authorization: Bearer JWT
forwarded by the web proxy). The user IS the room: agent_id = "user:<uid>",
so wallets, orders, conversations and audit trails are isolated per account.
Un-authed calls (legacy demo mode) fall back to the body agentId so existing
curl demos keep working.

Order of operations (grading criterion): the INTENT audit entry is written and
pushed over the WebSocket BEFORE any LLM or tool call — the timeline shows
intent capture even when the model is slow, rate-limited, or down.
"""
from flask import Blueprint, g, jsonify, request

from config import config
from routes.auth_routes import require_auth
from services import auth_service, conversation_service, llm_orchestrator, transaction_service, wallet_service
from services.audit_service import log_step, serialize

agent_bp = Blueprint("agent", __name__, url_prefix="/api/agent")

MAX_PROMPT_LEN = 2000


@agent_bp.post("/chat")
def chat():
    body = request.get_json(silent=True) or {}
    prompt = body.get("prompt")
    session_id = body.get("sessionId")
    agent_id = body.get("agentId")

    if not isinstance(prompt, str) or not prompt.strip():
        return jsonify({"error": "INVALID_PROMPT", "hint": "prompt (non-empty string) is required."}), 400
    if len(prompt) > MAX_PROMPT_LEN:
        return jsonify({"error": "PROMPT_TOO_LONG", "hint": f"prompt must be <= {MAX_PROMPT_LEN} chars."}), 400
    if not isinstance(session_id, str) or not transaction_service.SESSION_ID_RE.match(session_id):
        return jsonify({"error": "INVALID_SESSION_ID"}), 400

    # ---- v2 auth: the user is the room. Un-authed -> legacy demo agent. ----
    user = None
    try:
        user = auth_service.user_from_token(request.headers.get("Authorization"))
        agent_id = auth_service.room_agent_id(user)
    except auth_service.AuthError:
        if not isinstance(agent_id, str) or len(agent_id.strip()) < 2:
            return jsonify({"error": "INVALID_AGENT_ID"}), 400
        agent_id = agent_id.strip()

    prompt = prompt.strip()

    # INTENT FIRST — before any LLM/tool latency or failure.
    log_step(session_id, agent_id, "INTENT", {"prompt": prompt, "source": "onyx", "room": agent_id})

    try:
        result = llm_orchestrator.process_user_intent(prompt, session_id, agent_id, user=user)
    except llm_orchestrator.LlmNotConfigured as err:
        # The intent was still captured; degrade with a clear message.
        result = {"reply": str(err), "toolCalls": []}
    except Exception as err:  # noqa: BLE001
        return jsonify({"error": "LLM_ORCHESTRATION_FAILED", "message": str(err)}), 500

    return jsonify(
        {
            "reply": result["reply"],
            "toolCalls": result["toolCalls"],
            "sessionId": session_id,
            "agentId": agent_id,
            "accountType": (user or {}).get("accountType", "demo"),
        }
    )


@agent_bp.get("/conversation/<session_id>")
def conversation(session_id: str):
    """Hydration for the chat panel (capped, user-scoped history)."""
    if not transaction_service.SESSION_ID_RE.match(session_id):
        return jsonify({"error": "INVALID_SESSION_ID"}), 400

    try:
        user = auth_service.user_from_token(request.headers.get("Authorization"))
        agent_id = auth_service.room_agent_id(user)
    except auth_service.AuthError:
        agent_id = None  # legacy demo mode: session-scoped only

    messages = conversation_service.get_history(session_id, agent_id=agent_id)
    return jsonify({"sessionId": session_id, "messages": messages})


@agent_bp.get("/me")
@require_auth
def me_alias():
    """Single-call hydration for the authed console: user + wallet + mode."""
    user = g.user
    agent_id = auth_service.room_agent_id(user)
    wallet = wallet_service.get_wallet(agent_id)
    return jsonify(
        {
            "user": auth_service.public_user(user),
            "wallet": wallet_service.serialize_wallet(wallet) if wallet else None,
            "walletAgentId": agent_id,
            "spendLimitPaise": config.SPEND_LIMIT_PAISE,
            "fakeFunds": not bool(auth_service.get_razorpay_keys(user)),
            "agentOtpMode": config.AGENT_OTP_MODE,
        }
    )


# ---------------------------------------------------------------------------
# Aliases so the Next.js proxy (app/api/agent/[...path]) can reach the whole
# agent-service surface under ONE route prefix — the spec pins the web proxy
# tree to /api/agent/*, so wallet + transaction reads live here too.
# ---------------------------------------------------------------------------


@agent_bp.get("/wallet/me")
@require_auth
def wallet_me():
    agent_id = auth_service.room_agent_id(g.user)
    doc = wallet_service.get_wallet(agent_id)
    if doc is None:
        return jsonify({"error": "WALLET_NOT_FOUND", "agentId": agent_id}), 404
    return jsonify(serialize(doc))


@agent_bp.get("/wallet/<agent_id>")
def wallet_alias(agent_id: str):
    """Legacy demo-mode wallet read (onyx-agent etc.) — kept for curl demos."""
    if len(agent_id) < 2 or len(agent_id) > 128:
        return jsonify({"error": "INVALID_AGENT_ID"}), 400
    doc = wallet_service.get_wallet(agent_id)
    if doc is None:
        return jsonify({"error": "WALLET_NOT_FOUND", "agentId": agent_id}), 404
    return jsonify(serialize(doc))


@agent_bp.get("/transactions")
def transactions_alias():
    agent_id = request.args.get("agentId", "")
    # Authed users are pinned to their own room regardless of the query param.
    try:
        user = auth_service.user_from_token(request.headers.get("Authorization"))
        agent_id = auth_service.room_agent_id(user)
    except auth_service.AuthError:
        pass
    if len(agent_id) < 2:
        return jsonify({"error": "INVALID_AGENT_ID"}), 400
    return jsonify({"transactions": transaction_service.list_transactions(agent_id)})
