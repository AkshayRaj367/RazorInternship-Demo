"""POST /api/auth/* — the login system (human vs agent), BYOK Razorpay.

  POST /api/auth/register        { email, password, accountType, displayName? }
  POST /api/auth/verify-email    { email, code }
  POST /api/auth/login           { email, password }
  GET  /api/auth/me              (Bearer) account + wallet + payment mode
  POST /api/auth/razorpay        (Bearer) { keyId, keySecret }  -> BYOK mode
  DELETE /api/auth/razorpay      (Bearer) -> back to fake funds
  POST /api/auth/regenerate-key  (Bearer, agents) -> new MCP key
"""
from flask import Blueprint, g, jsonify, request

from config import config
from services import auth_service, wallet_service
from services.auth_service import AuthError

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@auth_bp.errorhandler(AuthError)
def _auth_error(err: AuthError):
    return jsonify({"error": err.code, "message": str(err), **({"data": err.data} if err.data else {})}), err.http_status


@auth_bp.post("/register")
def register():
    body = request.get_json(silent=True) or {}
    try:
        result = auth_service.register(
            email=body.get("email", ""),
            password=body.get("password", ""),
            account_type=str(body.get("accountType", "human")),
            display_name=body.get("displayName"),
        )
    except AuthError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    return jsonify(result), 201


@auth_bp.post("/verify-email")
def verify_email():
    body = request.get_json(silent=True) or {}
    try:
        result = auth_service.verify_email(body.get("email", ""), body.get("code", ""))
    except AuthError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    return jsonify(result)


@auth_bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    try:
        result = auth_service.login(body.get("email", ""), body.get("password", ""))
    except AuthError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    # 200 either way: 'verification' payloads are a normal login step, not an error.
    return jsonify(result)


def require_auth(view_fn):
    """Decorator: Authorization: Bearer <jwt> -> g.user (full user doc)."""

    from functools import wraps

    @wraps(view_fn)
    def wrapper(*args, **kwargs):
        if not config.auth_configured:
            return (
                jsonify(
                    {
                        "error": "AUTH_NOT_CONFIGURED",
                        "hint": "Set AUTH_JWT_SECRET (and ideally CRYPTO_SECRET) in .env, then restart agent-service.",
                    }
                ),
                503,
            )
        try:
            g.user = auth_service.user_from_token(request.headers.get("Authorization"))
        except AuthError as err:
            return jsonify({"error": err.code, "message": str(err)}), err.http_status
        return view_fn(*args, **kwargs)

    return wrapper


@auth_bp.get("/me")
@require_auth
def me():
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
            "smtpConfigured": config.smtp_configured,
        }
    )


@auth_bp.post("/razorpay")
@require_auth
def connect_razorpay():
    body = request.get_json(silent=True) or {}
    try:
        result = auth_service.set_razorpay_keys(g.user, body.get("keyId", ""), body.get("keySecret", ""))
    except AuthError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    return jsonify({"ok": True, "razorpay": result})


@auth_bp.delete("/razorpay")
@auth_bp.post("/razorpay/disconnect")
@require_auth
def disconnect_razorpay():
    result = auth_service.clear_razorpay_keys(g.user)
    return jsonify({"ok": True, "razorpay": result})


@auth_bp.post("/regenerate-key")
@require_auth
def regenerate_key():
    try:
        raw_key = auth_service.regenerate_mcp_key(g.user)
    except AuthError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    return jsonify({"ok": True, "mcpKey": raw_key, "note": "Store this key now — it will not be shown again."})
