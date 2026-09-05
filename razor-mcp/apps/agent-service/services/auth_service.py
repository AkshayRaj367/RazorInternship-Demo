"""Authentication + rooms + BYOK — the v2 login system.

ACCOUNT TYPES
  human: email + password; email verification via 6-digit code (SMTP, or
         DEV_MODE inline). Purchase OTPs go to the registered email.
  agent: email + password; verified instantly; issued a personal MCP API key
         (rzak_...) registered against mcp-server POST /internal/clients and
         bound to the agent's room ("user:<uid>"). Purchase OTPs are delivered
         INLINE in the transaction response (or auto-approved with
         AGENT_OTP_MODE=auto) — an agent has no inbox.

ROOMS
  Every account is one room. The wallet agent id IS the room:
  agent_id = "user:<uid>". Conversations, orders, transactions, audit trails
  and websocket rooms are all scoped by it.

JWT
  HS256, claims {sub, email, type, iat, exp}. Shared secret AUTH_JWT_SECRET
  (also read by ws-gateway for socket joins).

BYOK RAZORPAY
  Per-user key_id/key_secret stored Fernet-encrypted (CRYPTO_SECRET; falls
  back to a key derived from AUTH_JWT_SECRET when unset). mode: 'fake'
  (sandbox wallet funds — default) or 'byok' (real Razorpay TEST orders with
  the user's own keys). The secret NEVER leaves the server; the key_id
  (public by design, same as checkout.js needs) is returned for the modal.
"""
import base64
import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt as pyjwt
import requests
from cryptography.fernet import Fernet, InvalidToken

import db
import mcp_client
from config import config
from services import wallet_service
from services import email_service

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
MCP_KEY_PREFIX = "rzak_"


class AuthError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 400, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.data = data


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------

def issue_jwt(user: dict) -> str:
    now = _utcnow()
    payload = {
        "sub": str(user["_id"]),
        "email": user["email"],
        "type": user.get("accountType", "human"),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=config.AUTH_JWT_TTL_HOURS)).timestamp()),
    }
    return pyjwt.encode(payload, config.AUTH_JWT_SECRET, algorithm="HS256")


def decode_jwt(token: str) -> dict:
    """Raises AuthError on any failure (bad token / expired / wrong secret)."""
    try:
        return pyjwt.decode(token, config.AUTH_JWT_SECRET, algorithms=["HS256"])
    except pyjwt.ExpiredSignatureError:
        raise AuthError("TOKEN_EXPIRED", "Session expired — log in again.", 401)
    except pyjwt.InvalidTokenError:
        raise AuthError("TOKEN_INVALID", "Invalid auth token.", 401)


def user_from_token(auth_header: str | None) -> dict:
    """Authorization: Bearer <jwt> -> full user doc (or AuthError)."""
    if not auth_header or not auth_header.lower().startswith("bearer "):
        raise AuthError("UNAUTHORIZED", "Authorization: Bearer <token> header required.", 401)
    token = auth_header.split(" ", 1)[1].strip()
    claims = decode_jwt(token)
    user = db.users().find_one({"_id": _to_oid(claims.get("sub"))})
    if user is None:
        raise AuthError("ACCOUNT_NOT_FOUND", "Account no longer exists.", 401)
    return user


def _to_oid(value: Any):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise AuthError("TOKEN_INVALID", "Malformed subject id.", 401)


# ---------------------------------------------------------------------------
# Room helpers
# ---------------------------------------------------------------------------

def room_agent_id(user: dict) -> str:
    """The wallet/room id for an account: 'user:<uid>'."""
    return f"user:{user['_id']}"


def ensure_user_wallet(user: dict) -> dict:
    """Provision the sandbox wallet on first login (fake funds)."""
    return wallet_service.ensure_wallet(room_agent_id(user), config.FAKE_FUNDS_START_PAISE)


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------

def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")


def _check_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Email verification codes (registration)
# ---------------------------------------------------------------------------

def _issue_email_code(email: str, purpose: str, ttl_minutes: int = 10) -> str:
    code = f"{secrets.randbelow(1000000):06d}"
    code_hash = bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt(rounds=8)).decode("utf-8")
    now = _utcnow()
    db.email_codes().delete_many({"email": email, "purpose": purpose})
    db.email_codes().insert_one(
        {
            "email": email,
            "purpose": purpose,
            "codeHash": code_hash,
            "attempts": 0,
            "createdAt": now,
            "expiresAt": now + timedelta(minutes=ttl_minutes),
        }
    )
    return code


def _consume_email_code(email: str, purpose: str, code: str) -> bool:
    doc = db.email_codes().find_one({"email": email, "purpose": purpose})
    if doc is None:
        return False
    if doc.get("expiresAt", _utcnow()) <= _utcnow():
        db.email_codes().delete_one({"_id": doc["_id"]})
        return False
    if doc.get("attempts", 0) >= 5:
        db.email_codes().delete_one({"_id": doc["_id"]})
        return False
    db.email_codes().update_one({"_id": doc["_id"]}, {"$inc": {"attempts": 1}})
    try:
        if bcrypt.checkpw(code.strip().encode("utf-8"), doc["codeHash"].encode("utf-8")):
            db.email_codes().delete_one({"_id": doc["_id"]})
            return True
    except ValueError:
        pass
    return False


# ---------------------------------------------------------------------------
# MCP key issuance (agent accounts)
# ---------------------------------------------------------------------------

def _generate_mcp_key() -> str:
    return MCP_KEY_PREFIX + secrets.token_hex(24)


def _register_mcp_key(raw_key: str, room: str) -> None:
    """Register the key hash with mcp-server (bound to this room)."""
    url = f"{config.MCP_SERVER_URL.rstrip('/')}/internal/clients"
    try:
        resp = requests.post(
            url,
            json={"apiKey": raw_key, "agentName": room, "rateLimitPerMinute": 120},
            headers={
                "X-Internal-Key": config.MCP_SERVER_INTERNAL_API_KEY,
                "Content-Type": "application/json",
            },
            timeout=10,
        )
        if resp.status_code not in (200, 201):
            raise AuthError(
                "MCP_KEY_REGISTRATION_FAILED",
                f"mcp-server rejected the key registration (HTTP {resp.status_code}).",
                502,
            )
    except requests.RequestException as err:
        raise AuthError("MCP_KEY_REGISTRATION_FAILED", f"mcp-server unreachable: {err}", 502)


def regenerate_mcp_key(user: dict) -> str:
    """Issue a fresh MCP key for an agent account (old key keeps working until
    mcp-server key rotation; simplest safe behaviour is purely additive)."""
    if user.get("accountType") != "agent":
        raise AuthError("NOT_AN_AGENT_ACCOUNT", "Only agent accounts hold MCP keys.", 400)
    raw_key = _generate_mcp_key()
    _register_mcp_key(raw_key, room_agent_id(user))
    masked = raw_key[:10] + "…" + raw_key[-4:]
    db.users().update_one({"_id": user["_id"]}, {"$set": {"mcpKeyMasked": masked, "updatedAt": _utcnow()}})
    return raw_key


# ---------------------------------------------------------------------------
# Registration / login / verification
# ---------------------------------------------------------------------------

def register(email: str, password: str, account_type: str, display_name: str | None = None) -> dict:
    email = (email or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise AuthError("INVALID_EMAIL", "A valid email address is required.")
    if account_type not in ("human", "agent"):
        raise AuthError("INVALID_ACCOUNT_TYPE", "accountType must be 'human' or 'agent'.")
    if not isinstance(password, str) or len(password) < 8 or len(password) > 128:
        raise AuthError("WEAK_PASSWORD", "Password must be 8-128 characters.")

    if db.users().find_one({"email": email}):
        raise AuthError("EMAIL_TAKEN", "An account with this email already exists.", 409)

    now = _utcnow()
    user = {
        "_id": _new_oid(),
        "email": email,
        "passwordHash": _hash_password(password),
        "displayName": (display_name or email.split("@")[0]).strip()[:60] or email,
        "accountType": account_type,
        "emailVerified": account_type == "agent",  # agents verify by holding a key
        "razorpay": {"mode": "fake", "keyId": None, "keySecretEnc": None},
        "mcpKeyMasked": None,
        "createdAt": now,
        "updatedAt": now,
    }

    mcp_key: str | None = None
    if account_type == "agent":
        mcp_key = _generate_mcp_key()

    try:
        db.users().insert_one(user)
    except Exception as err:  # noqa: BLE001
        if "E11000" in str(err) or getattr(err, "code", None) == 11000:
            raise AuthError("EMAIL_TAKEN", "An account with this email already exists.", 409)
        raise

    # Agent: register the key AFTER the user doc exists (room is stable now).
    if mcp_key is not None:
        _register_mcp_key(mcp_key, room_agent_id(user))
        db.users().update_one(
            {"_id": user["_id"]},
            {"$set": {"mcpKeyMasked": mcp_key[:10] + "…" + mcp_key[-4:], "updatedAt": _utcnow()}},
        )

    result: dict[str, Any] = {"user": public_user(user), "accountType": account_type}

    if account_type == "human":
        code = _issue_email_code(email, "verify_email")
        sent = email_service.send_verification_email(email, code)
        result["verification"] = {
            "required": True,
            "emailSent": sent,
            "delivery": "email" if sent else "dev",
        }
        if not sent and config.DEV_MODE:
            result["verification"]["devCode"] = code
    else:
        result["mcpKey"] = mcp_key  # shown ONCE — only place the raw key exists
        result["mcp"] = {
            "endpoint": "/mcp",
            "transport": "JSON-RPC 2.0 over HTTP",
            "header": "X-API-Key",
            "note": "Store this key now — it will not be shown again.",
        }

    return result


def _new_oid():
    from bson import ObjectId
    return ObjectId()


def verify_email(email: str, code: str) -> dict:
    email = (email or "").strip().lower()
    user = db.users().find_one({"email": email})
    if user is None:
        raise AuthError("ACCOUNT_NOT_FOUND", "No account with this email.", 404)
    if user.get("emailVerified"):
        return {"verified": True, "alreadyVerified": True}
    if not _consume_email_code(email, "verify_email", code or ""):
        raise AuthError("CODE_INVALID", "Wrong or expired verification code.", 401)
    db.users().update_one({"_id": user["_id"]}, {"$set": {"emailVerified": True, "updatedAt": _utcnow()}})
    user["emailVerified"] = True
    ensure_user_wallet(user)
    return {"verified": True, "token": issue_jwt(user), "user": public_user(user)}


def login(email: str, password: str) -> dict:
    email = (email or "").strip().lower()
    user = db.users().find_one({"email": email})
    if user is None or not _check_password(password or "", user.get("passwordHash", "")):
        raise AuthError("BAD_CREDENTIALS", "Email or password is incorrect.", 401)
    if not user.get("emailVerified"):
        # humans must verify first; agents are verified at birth
        code = _issue_email_code(email, "verify_email")
        sent = email_service.send_verification_email(email, code)
        resp: dict[str, Any] = {
            "verification": {"required": True, "emailSent": sent, "delivery": "email" if sent else "dev"},
        }
        if not sent and config.DEV_MODE:
            resp["verification"]["devCode"] = code
        return resp
    ensure_user_wallet(user)
    return {"token": issue_jwt(user), "user": public_user(user)}


def public_user(user: dict) -> dict:
    razorpay = user.get("razorpay") or {}
    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "displayName": user.get("displayName", user["email"]),
        "accountType": user.get("accountType", "human"),
        "emailVerified": bool(user.get("emailVerified")),
        "room": room_agent_id(user),
        "razorpay": {
            "mode": razorpay.get("mode", "fake"),
            "keyId": razorpay.get("keyId"),
            # keySecret NEVER leaves the server
        },
        "mcpKeyMasked": user.get("mcpKeyMasked"),
        "createdAt": user.get("createdAt").isoformat() if user.get("createdAt") else None,
    }


# ---------------------------------------------------------------------------
# BYOK Razorpay storage (Fernet-encrypted)
# ---------------------------------------------------------------------------

def _fernet() -> Fernet:
    if config.crypto_configured and len(config.CRYPTO_SECRET) >= 20:
        try:
            return Fernet(config.CRYPTO_SECRET.encode("utf-8"))
        except ValueError:
            pass
    # Derive a stable key from the JWT secret when CRYPTO_SECRET is unset.
    digest = hashlib.sha256(("byok:" + config.AUTH_JWT_SECRET).encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def set_razorpay_keys(user: dict, key_id: str, key_secret: str) -> dict:
    key_id = (key_id or "").strip()
    key_secret = (key_secret or "").strip()
    if not key_id.startswith("rzp_test_"):
        # Enforce TEST MODE keys only — no real funds, ever.
        raise AuthError(
            "TEST_MODE_ONLY",
            "Only rzp_test_... keys are accepted. Dashboard -> Settings -> API Keys -> Test.",
            400,
        )
    if len(key_secret) < 8:
        raise AuthError("INVALID_KEY_SECRET", "keySecret looks too short.", 400)

    enc = _fernet().encrypt(key_secret.encode("utf-8")).decode("utf-8")
    db.users().update_one(
        {"_id": user["_id"]},
        {
            "$set": {
                "razorpay": {"mode": "byok", "keyId": key_id, "keySecretEnc": enc},
                "updatedAt": _utcnow(),
            }
        },
    )
    return {"mode": "byok", "keyId": key_id}


def clear_razorpay_keys(user: dict) -> dict:
    db.users().update_one(
        {"_id": user["_id"]},
        {"$set": {"razorpay": {"mode": "fake", "keyId": None, "keySecretEnc": None}, "updatedAt": _utcnow()}},
    )
    return {"mode": "fake", "keyId": None}


def get_razorpay_keys(user: dict) -> tuple[str, str] | None:
    rzp = user.get("razorpay") or {}
    if rzp.get("mode") != "byok" or not rzp.get("keyId") or not rzp.get("keySecretEnc"):
        return None
    try:
        secret = _fernet().decrypt(rzp["keySecretEnc"].encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return None
    return rzp["keyId"], secret
