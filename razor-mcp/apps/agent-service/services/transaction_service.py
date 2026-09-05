"""Transaction engine — the SINGLE payment code path for every caller.

Flow (autonomous, amount <= SPEND_LIMIT_PAISE):
  idempotency pre-check -> MCP create_order (atomic stock lock) -> INVENTORY_LOCK
  audit -> GUARDRAIL_PASS audit -> [ACID txn: OCC debit + tx insert + Razorpay
  TEST order + order update] -> ORDER_GENERATED audit -> return 'pending'
  (webhook payment.captured later completes it).

Flow (OTP-gated, amount > SPEND_LIMIT_PAISE):
  same until INVENTORY_LOCK, then: transaction doc status 'awaiting_otp' +
  otp_challenges doc (bcrypt hash) -> GUARDRAIL_OTP_REQUIRED audit + ws
  'otp:required' -> 202. THE WALLET IS NOT TOUCHED until a human verifies.
  On verify: OTP_VERIFIED audit -> same ACID block with a server-side
  OtpAuthorization -> ORDER_GENERATED.

Idempotency / replay-attack prevention (both lines active):
  1. Pre-check: transactions.idempotencyKey lookup -> stored resultSnapshot is
     returned VERBATIM (no re-debit, no re-Razorpay call).
  2. DB level: unique index on idempotencyKey -> E11000 on concurrent same-key
     inserts is caught and the winner's snapshot is returned.

Concurrency: the debit is wallet_service.execute_debit — atomic OCC
find_one_and_update with 5 jittered-backoff retries, fresh guardrail check per
attempt, and multi-document ACID semantics via the passed Mongo session.
"""
import functools
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from bson.errors import InvalidId
from flask import jsonify, request
from pymongo import ReturnDocument

import db
import mcp_client
import razorpay_client
import ws_client
from config import config
from services import otp_service, wallet_service
from services.audit_service import log_step
from services.wallet_service import OtpAuthorization, WalletError

IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{8,200}$")
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{6,128}$")


class TransactionError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 400, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.data = data


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Reusable idempotency-key enforcement (Flask decorator — the Python twin of
# mcp-server's middleware/idempotency.ts; write endpoints use it, none hand-roll).
# ---------------------------------------------------------------------------

def require_idempotency_key(view_fn):
    @functools.wraps(view_fn)
    def wrapper(*args, **kwargs):
        body = request.get_json(silent=True) or {}
        raw = request.headers.get("Idempotency-Key") or body.get("idempotencyKey")
        key = raw.strip() if isinstance(raw, str) else None
        if not key or not IDEMPOTENCY_KEY_RE.match(key):
            return (
                jsonify(
                    {
                        "error": "MISSING_IDEMPOTENCY_KEY",
                        "hint": "Send an Idempotency-Key header or idempotencyKey field (8-200 chars, e.g. a UUID).",
                    }
                ),
                400,
            )
        return view_fn(*args, **kwargs, idempotency_key=key)

    return wrapper


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_items(items: Any) -> list[dict[str, Any]]:
    """Items reference local catalog skus OR live web products (webId from
    web_product_search). Exactly one of sku/webId per item."""
    if not isinstance(items, list) or not items or len(items) > 20:
        raise TransactionError("INVALID_ITEMS", "items must be a non-empty list (max 20).")
    cleaned = []
    for raw in items:
        if not isinstance(raw, dict):
            raise TransactionError("INVALID_ITEMS", "each item must be an object {sku|webId, qty}.")
        sku = raw.get("sku")
        web_id = raw.get("webId")
        qty = raw.get("qty")
        has_sku = isinstance(sku, str) and sku.strip()
        has_web = isinstance(web_id, str) and web_id.strip()
        if has_sku == has_web:  # both or neither
            raise TransactionError(
                "INVALID_ITEMS", "each item needs exactly ONE of: sku (catalog) or webId (live web product)."
            )
        if not isinstance(qty, int) or isinstance(qty, bool) or qty < 1 or qty > 100:
            raise TransactionError("INVALID_ITEMS", "qty must be an integer 1..100.")
        if has_sku:
            cleaned.append({"sku": sku.strip(), "qty": qty})
        else:
            cleaned.append({"webId": web_id.strip().upper(), "qty": qty})
    return cleaned


def _validate_session_id(session_id: Any) -> str:
    if not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
        raise TransactionError("INVALID_SESSION_ID", "sessionId must match [A-Za-z0-9._:-]{6,128}.")
    return session_id


def _response_for(doc: dict) -> dict:
    """Stored resultSnapshot replayed VERBATIM on idempotent hits."""
    snapshot = doc.get("resultSnapshot")
    if isinstance(snapshot, dict):
        return snapshot
    return {"status": doc.get("status"), "transactionId": str(doc["_id"]), "idempotencyKey": doc.get("idempotencyKey")}


# ---------------------------------------------------------------------------
# Order helpers (orders live in the shared cluster; agent-service transitions
# payment state on them directly — documented in docs/ARCHITECTURE.md)
# ---------------------------------------------------------------------------

def _get_order_doc(order_number: str) -> dict | None:
    return db.orders().find_one({"orderNumber": order_number})


_CANCELABLE_STATUSES = ("created", "payment_pending", "payment_failed", "recovery_in_progress")


def cancel_order_and_release_stock(order_number: str, reason: str, agent_id: str, session_id: str) -> bool:
    """Conditionally cancel the order and release reserved stock exactly once."""
    doc = db.orders().find_one_and_update(
        {"orderNumber": order_number, "status": {"$in": list(_CANCELABLE_STATUSES)}},
        {"$set": {"status": "cancelled", "updatedAt": _utcnow()}},
        return_document=ReturnDocument.AFTER,
    )
    if doc is None:
        return False  # already cancelled / paid / recovered — never double-release
    for item in doc.get("items", []):
        db.catalog_items().update_one(
            {"sku": item["sku"], "reservedStock": {"$gte": item["qty"]}},
            {"$inc": {"stock": item["qty"], "reservedStock": -item["qty"], "version": 1}},
        )
    log_step(
        session_id,
        agent_id,
        "ORDER_CANCELLED",
        {"orderNumber": order_number, "reason": reason},
        order_id=doc.get("_id"),
    )
    return True


# ---------------------------------------------------------------------------
# Core: execute_transaction — the one entrypoint for money movement
# ---------------------------------------------------------------------------

def execute_transaction(
    agent_id: str,
    session_id: str,
    items: Any,
    idempotency_key: str,
    source: str = "api",
    user: dict | None = None,
) -> dict:
    """Execute a guarded purchase. Returns a JSON-safe response dict.

    `source` ('api' | 'onyx' | 'mcp') is audit metadata ONLY — it never changes
    which rules apply. The guardrail is enforced identically for every source.

    v2 `user` (the authed account doc, when called through a logged-in session):
      * OTP delivery splits by account type (humans: email; agents: inline/auto)
      * payment mode: razorpay.mode 'byok' -> real Razorpay TEST order with the
        user's own keys (checkout modal + signature verification); 'fake'
        (default) -> the sandbox wallet debit path, unchanged.
    """
    _validate_session_id(session_id)
    cleaned_items = _validate_items(items)
    if not isinstance(agent_id, str) or len(agent_id.strip()) < 2:
        raise TransactionError("INVALID_AGENT_ID", "agentId must be a non-empty string.")
    if not isinstance(idempotency_key, str) or not IDEMPOTENCY_KEY_RE.match(idempotency_key):
        raise TransactionError("MISSING_IDEMPOTENCY_KEY", "idempotencyKey (8-200 chars) is required.")
    agent_id = agent_id.strip()

    # ---- Idempotency line 1: replay the stored result verbatim. ----
    existing = db.transactions().find_one({"idempotencyKey": idempotency_key})
    if existing is not None:
        return _response_for(existing)

    # ---- Create the order via the MCP server (atomic stock lock / web snapshot). ----
    try:
        order = mcp_client.create_order(cleaned_items, agent_id, idempotency_key)
    except mcp_client.McpRemoteError as err:
        if err.code == -32001:  # INSUFFICIENT_STOCK — deterministic, store the failure
            sku = (err.data or {}).get("sku") if isinstance(err.data, dict) else None
            return _record_failed_transaction(
                agent_id, session_id, idempotency_key, None, 0, cleaned_items,
                f"INSUFFICIENT_STOCK{'/' + sku if sku else ''}", source,
            )
        # Other remote errors (rate limit, unauthorized) are NOT stored — retrying
        # the same key should be possible once the condition clears.
        raise TransactionError("MCP_" + err.message, str(err), 502, err.data)
    except mcp_client.McpUnavailable as err:
        # Transient transport failure — deliberately not persisted so a retry
        # with the same idempotency key re-attempts instead of replaying failure.
        raise TransactionError("MCP_UNAVAILABLE", str(err), 503)

    order_number = order.get("orderNumber", "")
    amount_paise = int(order.get("totalPaise", 0))
    order_doc = _get_order_doc(order_number)
    order_oid = order_doc.get("_id") if order_doc else None

    log_step(
        session_id, agent_id, "INVENTORY_LOCK",
        {
            "orderNumber": order_number,
            "items": order.get("items", []),
            "totalPaise": amount_paise,
            "duplicateOrder": bool(order.get("duplicate")),
            "orderSource": order.get("orderSource", "catalog"),
            "source": source,
        },
        order_id=order_oid,
    )

    # ---- Guardrail path selection (UX only; enforcement lives in wallet_service). ----
    if amount_paise > config.SPEND_LIMIT_PAISE:
        # Agents in 'auto' mode are server-side auto-approved; humans NEVER are.
        if user is not None and user.get("accountType") == "agent" and config.agent_otp_auto:
            return _auto_approve_otp_transaction(
                agent_id, session_id, idempotency_key, order_number, order_oid,
                amount_paise, source,
            )
        return _create_otp_gated_transaction(
            agent_id, session_id, idempotency_key, order_number, order_oid,
            amount_paise, source, user=user,
        )

    if user is not None and _byok_enabled(user):
        return _execute_byok_payment(
            agent_id, session_id, idempotency_key, order_number, order_oid,
            amount_paise, source,
        )

    return _execute_payment(
        agent_id, session_id, idempotency_key, order_number, order_oid,
        amount_paise, tx_type="autonomous", authorization=None, source=source,
        pre_authorized=False,
    )


def _byok_enabled(user: dict) -> bool:
    """True when the account is connected to its own Razorpay TEST keys."""
    from services import auth_service

    return auth_service.get_razorpay_keys(user) is not None


# ---------------------------------------------------------------------------
# OTP-gated branch: amount above the limit — wallet untouched until verified
# ---------------------------------------------------------------------------

def _create_otp_gated_transaction(
    agent_id: str,
    session_id: str,
    idempotency_key: str,
    order_number: str,
    order_oid: ObjectId | None,
    amount_paise: int,
    source: str,
    user: dict | None = None,
) -> dict:
    tx_id = ObjectId()
    wallet = wallet_service.get_wallet(agent_id)
    version_before = wallet.get("version", 0) if wallet else 0

    challenge = otp_service.create_challenge(tx_id)
    otp_code = challenge["otp"]

    now = _utcnow()
    doc = {
        "_id": tx_id,
        "idempotencyKey": idempotency_key,
        "agentId": agent_id,
        "orderId": order_oid,
        "amountPaise": amount_paise,
        "type": "otp_gated",
        "status": "awaiting_otp",
        "walletVersionBeforeTx": version_before,
        "paymentMode": "byok" if (user is not None and _byok_enabled(user)) else "wallet",
        "userId": str(user["_id"]) if user is not None else None,
        "razorpayOrderId": None,
        "razorpayPaymentId": None,
        "failureReason": None,
        "createdAt": now,
        "updatedAt": now,
        # Auto-clears stuck awaiting_otp locks (partial TTL index) — the janitor
        # ALSO marks them expired + cancels the order first, so records survive.
        "expiresAt": now + timedelta(seconds=config.OTP_TTL_SECONDS + 60),
    }

    try:
        db.transactions().insert_one(doc)
    except Exception as err:  # noqa: BLE001
        if _is_duplicate_key(err):
            # Idempotency line 2: concurrent same-key execution raced past the
            # pre-check; the winner's stored snapshot is returned verbatim.
            winner = db.transactions().find_one({"idempotencyKey": idempotency_key})
            if winner is not None:
                return _response_for(winner)
        raise

    # ---- OTP DELIVERY (v2): split by account type. ----
    is_agent = user is not None and user.get("accountType") == "agent"
    delivery = "dev"
    if is_agent:
        delivery = "inline"  # the OTP is the agent's "inbox": returned in-band
    else:
        amount_inr = f"₹{amount_paise / 100:,.2f}"
        from services import email_service

        if email_service.send_purchase_otp_email(user.get("email", ""), otp_code, amount_inr, order_number or "—"):
            delivery = "email"

    response = {
        "status": "awaiting_otp",
        "transactionId": str(tx_id),
        "idempotencyKey": idempotency_key,
        "amountPaise": amount_paise,
        "orderNumber": order_number,
        "sessionId": session_id,
        "limitPaise": config.SPEND_LIMIT_PAISE,
        "otpDelivery": delivery,
    }
    if is_agent:
        # Agents get the code inline so they can complete verification via the
        # verify_purchase_otp tool / POST verify-otp endpoint.
        response["otp"] = otp_code
    elif delivery == "email":
        response["message"] = "An approval OTP was sent to your registered email."
    if config.DEV_MODE:
        # DEV ONLY: in production this is sent via SMS/email, never returned in
        # the API response. otp_service stores ONLY the bcrypt hash.
        response["devOtp"] = otp_code

    db.transactions().update_one(
        {"_id": tx_id},
        {"$set": {"resultSnapshot": dict(response), "otpChallengeId": None, "updatedAt": _utcnow()}},
    )

    log_step(
        session_id, agent_id, "GUARDRAIL_OTP_REQUIRED",
        {
            "amountPaise": amount_paise,
            "limitPaise": config.SPEND_LIMIT_PAISE,
            "orderNumber": order_number,
            "transactionId": str(tx_id),
            "source": source,
            "otpDelivery": delivery,
            "message": "Amount exceeds delegated limit — OTP verification required before any wallet debit.",
        },
        order_id=order_oid,
    )
    # Prompt the human gate in the UI (OTPModal.tsx listens for this).
    otp_payload = {
        "sessionId": session_id,
        "transactionId": str(tx_id),
        "amountPaise": amount_paise,
        "orderNumber": order_number,
        "delivery": delivery,
    }
    if config.DEV_MODE:
        otp_payload["devOtp"] = otp_code
    from services.audit_service import room_for

    ws_client.emit_to_room(room_for(session_id, agent_id), "otp:required", otp_payload)

    return dict(response)


def _auto_approve_otp_transaction(
    agent_id: str,
    session_id: str,
    idempotency_key: str,
    order_number: str,
    order_oid: ObjectId | None,
    amount_paise: int,
    source: str,
) -> dict:
    """AGENT_OTP_MODE=auto — server-side auto-approval for AGENT accounts only.
    Humans always get the real OTP gate, whatever this flag says."""
    tx_id = ObjectId()

    now = _utcnow()
    doc = {
        "_id": tx_id,
        "idempotencyKey": idempotency_key,
        "agentId": agent_id,
        "orderId": order_oid,
        "amountPaise": amount_paise,
        "type": "otp_gated",
        "status": "otp_verified",
        "paymentMode": "wallet",
        "otpAutoApproved": True,
        "walletVersionBeforeTx": (wallet_service.get_wallet(agent_id) or {}).get("version", 0),
        "razorpayOrderId": None,
        "razorpayPaymentId": None,
        "failureReason": None,
        "createdAt": now,
        "updatedAt": now,
        "expiresAt": now + timedelta(seconds=config.RECOVERY_SESSION_TTL_SECONDS + 60),
    }
    try:
        db.transactions().insert_one(doc)
    except Exception as err:  # noqa: BLE001
        if _is_duplicate_key(err):
            winner = db.transactions().find_one({"idempotencyKey": idempotency_key})
            if winner is not None:
                return _response_for(winner)
        raise

    log_step(
        session_id, agent_id, "OTP_AUTO_APPROVED",
        {
            "transactionId": str(tx_id),
            "amountPaise": amount_paise,
            "orderNumber": order_number,
            "reason": "AGENT_OTP_MODE=auto — agent account authorized server-side.",
        },
        order_id=order_oid,
    )

    # Server-side proof — identical to a human-verified authorization.
    authorization = OtpAuthorization(agent_id, tx_id, amount_paise)
    return _execute_payment(
        agent_id, session_id, idempotency_key, order_number, order_oid,
        amount_paise, tx_type="otp_gated", authorization=authorization,
        source=source, pre_authorized=True, existing_tx=doc,
    )


# ---------------------------------------------------------------------------
# BYOK payment branch — real Razorpay TEST orders with the USER's own keys.
# No wallet debit: money is "collected" by the user's Razorpay test account;
# capture is confirmed by checkout-signature verification (confirm-payment).
# ---------------------------------------------------------------------------

def _execute_byok_payment(
    agent_id: str,
    session_id: str,
    idempotency_key: str,
    order_number: str,
    order_oid: ObjectId | None,
    amount_paise: int,
    source: str,
) -> dict:
    from services import auth_service
    from flask import g as _g  # noqa: F401  (context not needed here; keys come from db)

    # resolve the user's keys from the room id (agent_id == "user:<uid>")
    user = db.users().find_one({"_id": _to_object_id(agent_id)})
    if user is None:
        return _record_failed_transaction(
            agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
            "BYOK_ACCOUNT_NOT_FOUND", source, order_number=order_number, cancel_order=True,
        )
    keys = auth_service.get_razorpay_keys(user)
    if keys is None:
        return _record_failed_transaction(
            agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
            "BYOK_NOT_CONFIGURED", source, order_number=order_number, cancel_order=True,
        )
    key_id, key_secret = keys

    tx_id = ObjectId()
    now = _utcnow()
    doc = {
        "_id": tx_id,
        "idempotencyKey": idempotency_key,
        "agentId": agent_id,
        "orderId": order_oid,
        "amountPaise": amount_paise,
        "type": "byok_payment",
        "status": "awaiting_payment",
        "paymentMode": "byok",
        "walletVersionBeforeTx": 0,
        "razorpayKeyUsed": key_id,
        "razorpayOrderId": None,
        "razorpayPaymentId": None,
        "failureReason": None,
        "createdAt": now,
        "updatedAt": now,
        "expiresAt": now + timedelta(seconds=config.RECOVERY_SESSION_TTL_SECONDS + 60),
    }
    try:
        db.transactions().insert_one(doc)
    except Exception as err:  # noqa: BLE001
        if _is_duplicate_key(err):
            winner = db.transactions().find_one({"idempotencyKey": idempotency_key})
            if winner is not None:
                return _response_for(winner)
        raise

    # Real Razorpay TEST order with the user's keys (public internet call).
    try:
        rzp_order = razorpay_client.create_order_with_keys(
            key_id, key_secret, amount_paise,
            receipt=order_number,
            notes={"orderNumber": order_number, "agentId": agent_id, "sessionId": session_id, "mode": "byok"},
        )
    except (razorpay_client.RazorpayCallFailed, razorpay_client.RazorpayNotConfigured) as err:
        return _record_failed_transaction(
            agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
            f"BYOK_ORDER_FAILED: {err}", source, tx_id=tx_id, order_number=order_number, cancel_order=True,
        )

    rzp_order_id = rzp_order.get("id", "")
    db.transactions().update_one(
        {"_id": tx_id},
        {"$set": {"razorpayOrderId": rzp_order_id, "updatedAt": _utcnow()}},
    )
    db.orders().update_one(
        {"orderNumber": order_number},
        {"$set": {"razorpayOrderId": rzp_order_id, "status": "payment_pending", "updatedAt": _utcnow()}},
    )

    response = {
        "status": "awaiting_payment",
        "transactionId": str(tx_id),
        "idempotencyKey": idempotency_key,
        "amountPaise": amount_paise,
        "orderNumber": order_number,
        "message": "Razorpay checkout opened with YOUR test keys — complete the payment in the modal.",
        "payment": {
            "provider": "razorpay",
            "mode": "byok",
            "checkoutKey": key_id,  # key_id is public by design (checkout.js needs it)
            "razorpayOrderId": rzp_order_id,
            "amountPaise": amount_paise,
            "currency": "INR",
        },
    }
    db.transactions().update_one({"_id": tx_id}, {"$set": {"resultSnapshot": response, "updatedAt": _utcnow()}})

    log_step(
        session_id, agent_id, "BYOK_PAYMENT_PENDING",
        {
            "orderNumber": order_number,
            "razorpayOrderId": rzp_order_id,
            "amountPaise": amount_paise,
            "razorpayKeyUsed": key_id,
            "source": source,
        },
        order_id=order_oid,
    )
    return response


def _to_object_id(agent_id: str) -> ObjectId:
    """agent_id 'user:<uid>' -> ObjectId (raises TransactionError on garbage)."""
    raw = agent_id.split(":", 1)[1] if ":" in agent_id else agent_id
    try:
        return ObjectId(raw)
    except (InvalidId, TypeError):
        raise TransactionError("INVALID_AGENT_ID", f"agent_id '{agent_id}' is not a room id.")


def confirm_byok_payment(transaction_id: str, razorpay_payment_id: str, razorpay_order_id: str, signature: str) -> tuple[dict, int]:
    """Verify the Razorpay checkout signature with the USER's stored key_secret
    and, on success, mark the transaction + order paid. Fail-closed."""
    try:
        tx_oid = ObjectId(transaction_id)
    except (InvalidId, TypeError):
        raise TransactionError("INVALID_TRANSACTION_ID", "transactionId must be a Mongo ObjectId hex.")

    tx = db.transactions().find_one({"_id": tx_oid})
    if tx is None:
        raise TransactionError("TRANSACTION_NOT_FOUND", f"No transaction {transaction_id}.", 404)
    if tx.get("status") == "paid":
        return _response_for(tx), 200
    if tx.get("paymentMode") != "byok":
        raise TransactionError("NOT_A_BYOK_TRANSACTION", "This transaction is not in BYOK mode.", 400)
    if tx.get("status") != "awaiting_payment":
        return _response_for(tx), 200

    user = db.users().find_one({"_id": _to_object_id(tx["agentId"])})
    keys = auth_keys_for_user(user)
    if keys is None:
        return {"status": "failed", "transactionId": str(tx_oid), "failureReason": "BYOK_KEYS_UNAVAILABLE"}, 400

    _, key_secret = keys
    expected = razorpay_client.checkout_signature(key_secret, razorpay_order_id, razorpay_payment_id)
    import hmac as _hmac

    if not _hmac.compare_digest(expected, (signature or "").strip().lower()):
        db.transactions().update_one(
            {"_id": tx_oid, "status": "awaiting_payment"},
            {"$set": {"status": "payment_failed", "failureReason": "SIGNATURE_MISMATCH", "updatedAt": _utcnow()}},
        )
        log_step(tx.get("resultSnapshot", {}).get("sessionId", f"tx-{transaction_id}"), tx["agentId"], "PAYMENT_FAILED",
                 {"transactionId": str(tx_oid), "reason": "SIGNATURE_MISMATCH", "orderNumber": tx.get("razorpayOrderId")},
                 order_id=tx.get("orderId"))
        return {"status": "payment_failed", "transactionId": str(tx_oid), "failureReason": "SIGNATURE_MISMATCH"}, 400

    # Signature verified — paid. (Webhook payment.captured would ALSO land here.)
    now = _utcnow()
    response = {
        "status": "paid",
        "transactionId": str(tx_oid),
        "idempotencyKey": tx.get("idempotencyKey"),
        "amountPaise": tx.get("amountPaise"),
        "orderNumber": (db.orders().find_one({"_id": tx.get("orderId")}) or {}).get("orderNumber"),
        "razorpayPaymentId": razorpay_payment_id,
        "razorpayOrderId": razorpay_order_id,
        "message": "BYOK test payment verified and captured.",
    }
    db.transactions().update_one(
        {"_id": tx_oid},
        {"$set": {"status": "paid", "razorpayPaymentId": razorpay_payment_id, "resultSnapshot": response, "updatedAt": now}},
    )
    if tx.get("orderId"):
        db.orders().update_one({"_id": tx["orderId"]}, {"$set": {"status": "paid", "updatedAt": now}})

    session_id = tx.get("resultSnapshot", {}).get("sessionId") or f"tx-{transaction_id}"
    order_doc = db.orders().find_one({"_id": tx.get("orderId")}) if tx.get("orderId") else None
    log_step(
        session_id, tx["agentId"], "BYOK_PAYMENT_CAPTURED",
        {
            "transactionId": str(tx_oid),
            "razorpayPaymentId": razorpay_payment_id,
            "razorpayOrderId": razorpay_order_id,
            "amountPaise": tx.get("amountPaise"),
            "orderNumber": order_doc.get("orderNumber") if order_doc else None,
        },
        order_id=tx.get("orderId"),
    )
    log_step(
        session_id, tx["agentId"], "ORDER_COMPLETED",
        {"orderNumber": order_doc.get("orderNumber") if order_doc else None, "via": "byok_signature_verify"},
        order_id=tx.get("orderId"),
    )
    return response, 200


def auth_keys_for_user(user: dict | None):
    if user is None:
        return None
    from services import auth_service

    return auth_service.get_razorpay_keys(user)


def _execute_byok_payment_after_otp(tx: dict, session_id: str, order_number: str) -> dict:
    """OTP-verified BYOK flow: create the Razorpay order with the user's keys
    and hand the checkout details back (no wallet debit)."""
    agent_id = tx["agentId"]
    tx_oid = tx["_id"]
    user = db.users().find_one({"_id": _to_object_id(agent_id)})
    keys = auth_keys_for_user(user)
    if keys is None:
        return _record_failed_transaction(
            agent_id, session_id, tx["idempotencyKey"], tx.get("orderId"), tx["amountPaise"], [],
            "BYOK_KEYS_UNAVAILABLE", "otp_verify", tx_id=tx_oid, order_number=order_number, cancel_order=True,
        )
    key_id, key_secret = keys
    try:
        rzp_order = razorpay_client.create_order_with_keys(
            key_id, key_secret, tx["amountPaise"],
            receipt=order_number,
            notes={"orderNumber": order_number, "agentId": agent_id, "sessionId": session_id, "mode": "byok_otp"},
        )
    except (razorpay_client.RazorpayCallFailed, razorpay_client.RazorpayNotConfigured) as err:
        return _record_failed_transaction(
            agent_id, session_id, tx["idempotencyKey"], tx.get("orderId"), tx["amountPaise"], [],
            f"BYOK_ORDER_FAILED: {err}", "otp_verify", tx_id=tx_oid, order_number=order_number, cancel_order=True,
        )

    rzp_order_id = rzp_order.get("id", "")
    response = {
        "status": "awaiting_payment",
        "transactionId": str(tx_oid),
        "idempotencyKey": tx["idempotencyKey"],
        "amountPaise": tx["amountPaise"],
        "orderNumber": order_number,
        "message": "OTP verified — Razorpay checkout opened with YOUR test keys.",
        "payment": {
            "provider": "razorpay",
            "mode": "byok",
            "checkoutKey": key_id,
            "razorpayOrderId": rzp_order_id,
            "amountPaise": tx["amountPaise"],
            "currency": "INR",
        },
    }
    db.transactions().update_one(
        {"_id": tx_oid},
        {"$set": {"status": "awaiting_payment", "paymentMode": "byok", "razorpayOrderId": rzp_order_id,
                  "resultSnapshot": response, "updatedAt": _utcnow()}},
    )
    db.orders().update_one(
        {"orderNumber": order_number},
        {"$set": {"razorpayOrderId": rzp_order_id, "status": "payment_pending", "updatedAt": _utcnow()}},
    )
    log_step(
        session_id, agent_id, "BYOK_PAYMENT_PENDING",
        {"orderNumber": order_number, "razorpayOrderId": rzp_order_id, "amountPaise": tx["amountPaise"],
         "razorpayKeyUsed": key_id, "source": "otp_verify"},
        order_id=tx.get("orderId"),
    )
    return response


# ---------------------------------------------------------------------------
# The ACID payment block — used by BOTH the autonomous path and the
# post-OTP-verified path. This is the only place that debits wallets.
# ---------------------------------------------------------------------------

def _execute_payment(
    agent_id: str,
    session_id: str,
    idempotency_key: str,
    order_number: str,
    order_oid: ObjectId | None,
    amount_paise: int,
    tx_type: str,
    authorization: OtpAuthorization | None,
    source: str,
    pre_authorized: bool,
    existing_tx: dict | None = None,
) -> dict:
    tx_id = existing_tx["_id"] if existing_tx else ObjectId()

    # Pre-flight wallet sanity (deterministic failures -> recorded, not silent).
    wallet = wallet_service.get_wallet(agent_id)
    if wallet is None:
        return _record_failed_transaction(
            agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
            "WALLET_NOT_FOUND", source, tx_id=tx_id, order_number=order_number,
        )
    if wallet.get("status") != "active":
        return _record_failed_transaction(
            agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
            "WALLET_FROZEN", source, tx_id=tx_id, order_number=order_number,
        )
    if wallet.get("balancePaise", 0) < amount_paise:
        return _record_failed_transaction(
            agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
            "INSUFFICIENT_FUNDS", source, tx_id=tx_id, order_number=order_number,
        )

    version_before = wallet.get("version", 0)

    if not pre_authorized:
        log_step(
            session_id, agent_id, "GUARDRAIL_PASS",
            {
                "amountPaise": amount_paise,
                "limitPaise": config.SPEND_LIMIT_PAISE,
                "walletVersionBefore": version_before,
                "type": tx_type,
                "source": source,
            },
            order_id=order_oid,
        )

    # ---- Multi-document ACID transaction -----------------------------------
    # debit + transaction-doc insert + Razorpay TEST order creation commit or
    # roll back TOGETHER: a Razorpay failure after the debit cannot leave the
    # wallet decremented with no corresponding record.
    # PRODUCTION NOTE: calling an external API inside the txn snapshot window is
    # acceptable here ONLY because this is TEST mode with no queue infra. The
    # production seam is a transactional outbox + worker (see razorpay_client.py).
    client = db.get_client()
    last_error: Exception | None = None

    for attempt in range(1, 4):  # whole-txn retries on OCC exhaustion / transient races
        try:
            with client.start_session() as s:
                def _txn_callback(s):
                    # Guardrail is re-derived FRESH inside every attempt by
                    # wallet_service.execute_debit (no cached decision, no
                    # caller-supplied flag).
                    wallet_after = wallet_service.execute_debit(
                        agent_id, amount_paise, session=s, authorization=authorization
                    )

                    now = _utcnow()
                    tx_doc = existing_tx or {
                        "_id": tx_id,
                        "idempotencyKey": idempotency_key,
                        "agentId": agent_id,
                        "orderId": order_oid,
                        "amountPaise": amount_paise,
                        "type": tx_type,
                        "status": "pending",
                        "walletVersionBeforeTx": version_before,
                        "razorpayOrderId": None,
                        "razorpayPaymentId": None,
                        "failureReason": None,
                        "createdAt": now,
                        "updatedAt": now,
                        # Generous pending TTL (stuck-lock backstop; the janitor
                        # expires orders/records before this ever fires).
                        "expiresAt": now + timedelta(seconds=config.RECOVERY_SESSION_TTL_SECONDS + 60),
                    }
                    if not existing_tx:
                        # Idempotency line 2 (inside txn): unique index races resolve
                        # to the winner's snapshot.
                        try:
                            db.transactions().insert_one(tx_doc, session=s)
                        except Exception as err:  # noqa: BLE001
                            if _is_duplicate_key(err):
                                winner = db.transactions().find_one(
                                    {"idempotencyKey": idempotency_key}, session=s
                                )
                                if winner is not None:
                                    return ("duplicate", winner, None)
                            raise
                    else:
                        db.transactions().update_one(
                            {"_id": tx_id, "status": {"$in": ["awaiting_otp", "otp_verified"]}},
                            {"$set": {"status": "pending", "updatedAt": now}},
                            session=s,
                        )

                    # Razorpay TEST order (REAL API call — failures abort the txn
                    # and roll the debit back). When NO server-level Razorpay keys
                    # are configured, the payment is captured in SANDBOX mode:
                    # the wallet debit stands, no external order object exists.
                    # (Adding RAZORPAY_KEY_ID later upgrades fidelity without
                    # changing this code path; per-user BYOK runs separately.)
                    rzp_order_id = ""
                    sandbox_capture = not razorpay_client.is_configured()
                    if sandbox_capture:
                        db.orders().update_one(
                            {"orderNumber": order_number},
                            {"$set": {"status": "paid", "updatedAt": _utcnow()}},
                            session=s,
                        )
                    else:
                        rzp_order = razorpay_client.create_test_order(
                            amount_paise,
                            receipt=order_number,
                            notes={
                                "orderNumber": order_number,
                                "agentId": agent_id,
                                "sessionId": session_id,
                                "type": tx_type,
                            },
                        )
                        rzp_order_id = rzp_order.get("id", "")
                        db.orders().update_one(
                            {"orderNumber": order_number},
                            {
                                "$set": {
                                    "razorpayOrderId": rzp_order_id,
                                    "status": "payment_pending",
                                    "updatedAt": _utcnow(),
                                }
                            },
                            session=s,
                        )
                    db.transactions().update_one(
                        {"_id": tx_id},
                        {"$set": {"razorpayOrderId": rzp_order_id or None, "updatedAt": _utcnow()}},
                        session=s,
                    )
                    return ("ok", wallet_after, rzp_order_id, sandbox_capture)

                outcome = s.with_transaction(_txn_callback)
                kind, wallet_after, rzp_order_id, sandbox_capture = outcome[0], outcome[1], outcome[2], outcome[3]

                if kind == "duplicate":
                    return _response_for(wallet_after)  # winner's snapshot, verbatim

            if sandbox_capture:
                response = {
                    "status": "paid",  # sandbox capture — wallet debited, no external gateway
                    "transactionId": str(tx_id),
                    "idempotencyKey": idempotency_key,
                    "amountPaise": amount_paise,
                    "orderNumber": order_number,
                    "razorpayOrderId": None,
                    "walletBalancePaise": wallet_after.get("balancePaise"),
                    "message": "Sandbox capture: wallet debited (no server Razorpay keys configured).",
                }
            else:
                response = {
                    "status": "pending",  # awaiting Razorpay payment.captured webhook
                    "transactionId": str(tx_id),
                    "idempotencyKey": idempotency_key,
                    "amountPaise": amount_paise,
                    "orderNumber": order_number,
                    "razorpayOrderId": rzp_order_id,
                    "walletBalancePaise": wallet_after.get("balancePaise"),
                    "message": "Payment initiated — order awaiting Razorpay confirmation.",
                }
            db.transactions().update_one(
                {"_id": tx_id},
                {"$set": {"resultSnapshot": response, "updatedAt": _utcnow()}},
            )

            log_step(
                session_id, agent_id, "ORDER_GENERATED",
                {
                    "orderNumber": order_number,
                    "razorpayOrderId": rzp_order_id or None,
                    "amountPaise": amount_paise,
                    "walletBalancePaise": wallet_after.get("balancePaise"),
                    "type": tx_type,
                    "source": source,
                    "sandboxCapture": sandbox_capture,
                },
                order_id=order_oid,
            )
            if sandbox_capture:
                log_step(
                    session_id, agent_id, "ORDER_COMPLETED",
                    {"orderNumber": order_number, "via": "sandbox_capture", "amountPaise": amount_paise},
                    order_id=order_oid,
                )
            return dict(response)

        except razorpay_client.RazorpayNotConfigured as err:
            # Txn aborted: wallet debit already rolled back with the insert.
            return _record_failed_transaction(
                agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
                "RAZORPAY_NOT_CONFIGURED", source, tx_id=tx_id, order_number=order_number,
                cancel_order=True,
            )
        except razorpay_client.RazorpayCallFailed as err:
            return _record_failed_transaction(
                agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
                f"RAZORPAY_ORDER_FAILED: {err}", source, tx_id=tx_id,
                order_number=order_number, cancel_order=True,
            )
        except wallet_service.GuardrailViolation as err:
            # Someone attempted a >limit debit without verified OTP authorization
            # (defense-in-depth; execute_transaction routes those to the OTP path
            # first). Fail CLOSED, record the attempt.
            return _record_failed_transaction(
                agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
                f"GUARDRAIL_VIOLATION: {err.code}", source, tx_id=tx_id,
                order_number=order_number, cancel_order=True,
            )
        except wallet_service.ConcurrentModificationMaxRetries as err:
            # Subclass of WalletError — MUST precede the generic WalletError
            # handler so the retry branch is actually reachable.
            last_error = err
            continue  # retry the whole ACID txn with a fresh snapshot
        except wallet_service.WalletError as err:
            return _record_failed_transaction(
                agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
                err.code, source, tx_id=tx_id, order_number=order_number,
                cancel_order=True,
            )

    return _record_failed_transaction(
        agent_id, session_id, idempotency_key, order_oid, amount_paise, [],
        f"CONCURRENT_MODIFICATION_MAX_RETRIES: {last_error}", source,
        tx_id=tx_id, order_number=order_number, cancel_order=True,
    )


def _is_duplicate_key(err: Exception) -> bool:
    code = getattr(err, "code", None)
    if code == 11000:
        return True
    msg = str(err)
    return "E11000" in msg or "duplicate key" in msg.lower()


def _record_failed_transaction(
    agent_id: str,
    session_id: str,
    idempotency_key: str,
    order_oid: ObjectId | None,
    amount_paise: int,
    items: list,
    reason: str,
    source: str,
    tx_id: ObjectId | None = None,
    order_number: str | None = None,
    cancel_order: bool = False,
) -> dict:
    """Record a deterministic failure so idempotent replays return it verbatim."""
    tx_id = tx_id or ObjectId()
    now = _utcnow()
    response = {
        "status": "failed",
        "transactionId": str(tx_id),
        "idempotencyKey": idempotency_key,
        "amountPaise": amount_paise,
        "orderNumber": order_number,
        "failureReason": reason,
    }
    try:
        db.transactions().update_one(
            {"_id": tx_id},
            {
                "$set": {
                    "idempotencyKey": idempotency_key,
                    "agentId": agent_id,
                    "orderId": order_oid,
                    "amountPaise": amount_paise,
                    "type": "autonomous",
                    "status": "failed",
                    "walletVersionBeforeTx": (wallet_service.get_wallet(agent_id) or {}).get("version", 0),
                    "razorpayOrderId": None,
                    "razorpayPaymentId": None,
                    "failureReason": reason,
                    "createdAt": now,
                    "updatedAt": now,
                    "resultSnapshot": response,
                }
            },
            upsert=True,
        )
    except Exception as err:  # noqa: BLE001
        if not _is_duplicate_key(err):
            raise

    if cancel_order and order_number:
        cancel_order_and_release_stock(order_number, reason, agent_id, session_id)

    log_step(
        session_id, agent_id, "ORDER_CANCELLED",
        {"orderNumber": order_number, "reason": reason, "source": source},
        order_id=order_oid,
    )
    return dict(response)


# ---------------------------------------------------------------------------
# OTP verification — the human approval gate
# ---------------------------------------------------------------------------

def verify_otp(transaction_id: str, otp: str, session_id_hint: str = "") -> tuple[dict, int]:
    """Verify the human-entered OTP and, on success, execute the OTP-gated payment.

    Returns (response, http_status).
    """
    try:
        tx_oid = ObjectId(transaction_id)
    except (InvalidId, TypeError):
        raise TransactionError("INVALID_TRANSACTION_ID", "transactionId must be a Mongo ObjectId hex.")

    tx = db.transactions().find_one({"_id": tx_oid})
    if tx is None:
        raise TransactionError("TRANSACTION_NOT_FOUND", f"No transaction {transaction_id}.", 404)

    if tx.get("status") != "awaiting_otp":
        # Idempotent replay: already verified / completed / failed / rejected.
        return _response_for(tx), 200

    agent_id = tx["agentId"]
    session_id = tx.get("resultSnapshot", {}).get("sessionId") or session_id_hint or f"tx-{transaction_id}"
    # Prefer the sessionId captured at creation for room targeting.
    order_doc = db.orders().find_one({"_id": tx.get("orderId")}) if tx.get("orderId") else None
    order_number = order_doc.get("orderNumber") if order_doc else None

    outcome, challenge = otp_service.verify_and_claim(tx_oid, otp or "")

    if outcome == "verified":
        log_step(
            session_id, agent_id, "OTP_VERIFIED",
            {"transactionId": str(tx_oid), "attempts": challenge.get("attempts"), "orderNumber": order_number},
            order_id=tx.get("orderId"),
        )
        db.transactions().update_one(
            {"_id": tx_oid, "status": "awaiting_otp"},
            {"$set": {"status": "otp_verified", "updatedAt": _utcnow()}},
        )
        tx["status"] = "otp_verified"

        # BYOK mode: after human approval, open the Razorpay checkout with the
        # user's own keys (no wallet debit). Wallet mode: the guarded debit.
        if tx.get("paymentMode") == "byok":
            return _execute_byok_payment_after_otp(tx, session_id, order_number or ""), 200

        # Server-side proof — the ONLY way an above-limit debit can proceed.
        authorization = OtpAuthorization(agent_id, tx_oid, tx["amountPaise"])
        response = _execute_payment(
            agent_id, session_id, tx["idempotencyKey"], order_number or "",
            tx.get("orderId"), tx["amountPaise"], tx_type="otp_gated",
            authorization=authorization, source="otp_verify",
            pre_authorized=True, existing_tx=tx,
        )
        return response, 200

    if outcome == "already_verified":
        return _response_for(tx), 200

    if outcome == "max_attempts":
        db.transactions().update_one(
            {"_id": tx_oid, "status": "awaiting_otp"},
            {"$set": {"status": "rejected", "failureReason": "OTP_MAX_ATTEMPTS", "updatedAt": _utcnow()}},
        )
        db.transactions().update_one({"_id": tx_oid}, {"$unset": {"expiresAt": ""}})
        if order_number:
            cancel_order_and_release_stock(order_number, "OTP_MAX_ATTEMPTS", agent_id, session_id)
        else:
            log_step(session_id, agent_id, "ORDER_CANCELLED",
                     {"transactionId": str(tx_oid), "reason": "OTP_MAX_ATTEMPTS"})
        return (
            {"status": "rejected", "transactionId": str(tx_oid),
             "message": "3 failed OTP attempts — transaction rejected and stock released."},
            401,
        )

    if outcome == "expired":
        db.transactions().update_one(
            {"_id": tx_oid, "status": "awaiting_otp"},
            {"$set": {"status": "expired", "failureReason": "OTP_EXPIRED", "updatedAt": _utcnow()},
             "$unset": {"expiresAt": ""}},
        )
        if order_number:
            cancel_order_and_release_stock(order_number, "OTP_EXPIRED", agent_id, session_id)
        return (
            {"status": "expired", "transactionId": str(tx_oid), "message": "OTP challenge expired (5-minute TTL)."},
            410,
        )

    # outcome == 'wrong'
    left = otp_service.attempts_left(tx_oid)
    return (
        {"status": "awaiting_otp", "transactionId": str(tx_oid),
         "attemptsLeft": left, "message": "Incorrect OTP."},
        401,
    )


# ---------------------------------------------------------------------------
# Janitor — expires stuck awaiting_otp / pending transactions BEFORE the TTL
# index deletes them, cancelling the order and releasing reserved stock.
# ---------------------------------------------------------------------------

def expire_stale_transactions(limit: int = 100) -> int:
    now = _utcnow()
    stale = db.transactions().find(
        {"status": {"$in": ["pending", "awaiting_otp"]}, "expiresAt": {"$lt": now}},
        {"_id": 1, "agentId": 1, "orderId": 1, "idempotencyKey": 1, "status": 1},
    ).limit(limit)
    expired = 0
    for tx in stale:
        order_doc = db.orders().find_one({"_id": tx.get("orderId")}) if tx.get("orderId") else None
        # PRODUCTION NOTE: expiring a debit-ed 'pending' transaction would also
        # trigger a wallet credit (refund) here; out of scope for the TEST-mode build.
        db.transactions().update_one(
            {"_id": tx["_id"], "status": {"$in": ["pending", "awaiting_otp"]}},
            {"$set": {"status": "expired", "failureReason": "TTL_EXPIRED", "updatedAt": now},
             "$unset": {"expiresAt": ""}},
        )
        if order_doc and order_doc.get("orderNumber"):
            cancel_order_and_release_stock(
                order_doc["orderNumber"], "TTL_EXPIRED", tx["agentId"], f"tx-{tx['_id']}"
            )
        expired += 1
    return expired


def list_transactions(agent_id: str, limit: int = 20) -> list[dict]:
    cursor = (
        db.transactions()
        .find({"agentId": agent_id})
        .sort([("createdAt", -1)])
        .limit(limit)
    )
    out = []
    for doc in cursor:
        out.append(
            {
                "transactionId": str(doc["_id"]),
                "idempotencyKey": doc.get("idempotencyKey"),
                "agentId": doc.get("agentId"),
                "amountPaise": doc.get("amountPaise"),
                "type": doc.get("type"),
                "status": doc.get("status"),
                "razorpayOrderId": doc.get("razorpayOrderId"),
                "failureReason": doc.get("failureReason"),
                "createdAt": doc.get("createdAt").isoformat() if doc.get("createdAt") else None,
                "updatedAt": doc.get("updatedAt").isoformat() if doc.get("updatedAt") else None,
            }
        )
    return out


def generate_idempotency_key() -> str:
    """Helper for programmatic callers (e.g. Onyx's checkout_and_pay tool)."""
    return str(uuid.uuid4())

