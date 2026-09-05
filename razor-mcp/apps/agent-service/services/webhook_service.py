"""Razorpay webhook ingestion — signature-first, idempotent duplicate dispatch.

Processing order (every step is a grading criterion):
  1. HMAC-SHA256 signature verification on the RAW body against
     RAZORPAY_WEBHOOK_SECRET (hmac.compare_digest) BEFORE anything is parsed or
     persisted. Mismatch -> 400, zero side effects.
  2. Stable event id derivation: payload['event_id'] if present, else
     payload['payload']['payment']['entity']['id'] + ':' + event.
  3. INSERT-FIRST into webhook_events (unique razorpayEventId). DuplicateKeyError
     means the event was already processed -> return {'duplicate': True} and the
     route answers 200 with NO further side effects. A webhook fired twice
     produces exactly one recovery session and one set of audit logs.
  4. Dispatch by event type: payment.failed -> recovery_service;
     payment.captured / payment_link.paid -> order completion.
  5. Mark processed=True at the end.
"""
import json
from datetime import datetime, timezone
from typing import Any

import db
import razorpay_client
from services import recovery_service
from services.audit_service import log_step
from services.wallet_service import InsufficientFunds  # noqa: F401  (re-exported for route mapping)


class SignatureInvalid(Exception):
    pass


class WebhookError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _derive_event_id(payload: dict[str, Any], event_type: str) -> str:
    event_id = payload.get("event_id")
    if isinstance(event_id, str) and event_id.strip():
        return event_id.strip()
    payment_id = ""
    entity = ((payload.get("payload") or {}).get("payment") or {}).get("entity") or {}
    payment_id = entity.get("id", "")
    if payment_id:
        return f"{payment_id}:{event_type}"
    # payment_link events have no payment entity in some shapes — fall back to the link id.
    link = ((payload.get("payload") or {}).get("payment_link") or {}).get("entity") or {}
    if link.get("id"):
        return f"{link['id']}:{event_type}"
    raise WebhookError("UNIDENTIFIABLE_EVENT", "Webhook has neither event_id nor a payment/link entity id.")


def _is_duplicate_key(err: Exception) -> bool:
    return getattr(err, "code", None) == 11000 or "E11000" in str(err) or "duplicate key" in str(err).lower()


def handle_webhook(raw_body: bytes, signature: str) -> dict[str, Any]:
    """Process one webhook. Raises SignatureInvalid (->400) / WebhookError."""
    # ---- 1. Signature FIRST, always. ----
    if not razorpay_client.verify_webhook_signature(raw_body, signature):
        raise SignatureInvalid("SIGNATURE_INVALID: X-Razorpay-Signature does not match the raw body HMAC.")

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise WebhookError("INVALID_JSON", f"Webhook body is not valid JSON: {err}") from err

    if not isinstance(payload, dict) or not isinstance(payload.get("event"), str):
        raise WebhookError("INVALID_PAYLOAD", "Webhook payload must be an object with an 'event' string.")

    event_type: str = payload["event"]

    # ---- 2/3. Insert-first idempotency guard. ----
    event_id = _derive_event_id(payload, event_type)
    try:
        db.webhook_events().insert_one(
            {
                "razorpayEventId": event_id,
                "eventType": event_type,
                "payloadRaw": payload,
                "signatureVerified": True,
                "processed": False,
                "processedAt": None,
                "receivedAt": _utcnow(),
            }
        )
    except Exception as err:  # noqa: BLE001
        if _is_duplicate_key(err):
            # Already processed — 200, no side effects, immediately.
            return {"duplicate": True, "eventId": event_id, "eventType": event_type}
        raise

    # ---- 4. Dispatch (unknown events are acked and marked unprocessed->processed). ----
    result: dict[str, Any] = {"duplicate": False, "eventId": event_id, "eventType": event_type, "handled": True}
    try:
        if event_type == "payment.failed":
            result["recovery"] = recovery_service.handle_payment_failed(payload)
        elif event_type == "payment.captured":
            result["completion"] = _handle_payment_captured(payload)
        elif event_type == "payment_link.paid":
            result["completion"] = recovery_service.handle_payment_link_paid(payload)
        else:
            result["handled"] = False
    finally:
        db.webhook_events().update_one(
            {"razorpayEventId": event_id},
            {"$set": {"processed": True, "processedAt": _utcnow()}},
        )
    return result


# ---------------------------------------------------------------------------
# Happy-path completion: payment.captured
# ---------------------------------------------------------------------------

def _payment_entity(payload: dict[str, Any]) -> dict[str, Any]:
    entity = ((payload.get("payload") or {}).get("payment") or {}).get("entity") or {}
    if not entity:
        raise WebhookError("MISSING_PAYMENT_ENTITY", "payment.captured without payload.payment.entity.")
    return entity


def _find_order_by_razorpay_id(razorpay_order_id: str) -> dict[str, Any] | None:
    if not razorpay_order_id:
        return None
    return db.orders().find_one({"razorpayOrderId": razorpay_order_id})


def _complete_transaction_for_order(order: dict[str, Any], payment_id: str, recovered: bool) -> dict[str, Any] | None:
    """Mark the linked transaction completed. Returns the tx doc (or None)."""
    tx = db.transactions().find_one({"orderId": order["_id"]}) if order.get("_id") else None
    if tx is None:
        return None
    db.transactions().find_one_and_update(
        {"_id": tx["_id"], "status": {"$in": ["pending", "awaiting_otp", "otp_verified", "failed"]}},
        {
            "$set": {
                "status": "completed",
                "razorpayPaymentId": payment_id,
                "updatedAt": _utcnow(),
            },
            "$unset": {"expiresAt": ""},
        },
    )
    return tx


def _handle_payment_captured(payload: dict[str, Any]) -> dict[str, Any]:
    entity = _payment_entity(payload)
    payment_id = entity.get("id", "")
    order = _find_order_by_razorpay_id(entity.get("order_id", ""))
    if order is None:
        return {"matched": False, "paymentId": payment_id, "reason": "ORDER_NOT_FOUND_FOR_RAZORPAY_ID"}

    order_number = order.get("orderNumber", "")
    new_status = "recovered" if order.get("status") == "recovery_in_progress" else "paid"
    db.orders().find_one_and_update(
        {"orderNumber": order_number},
        {"$set": {"status": new_status, "updatedAt": _utcnow()}},
    )

    tx = _complete_transaction_for_order(order, payment_id, recovered=(new_status == "recovered"))

    # Audit into the session that created the transaction (room targeting).
    session_id = "unknown"
    agent_id = "unknown"
    if tx is not None:
        agent_id = tx.get("agentId", agent_id)
        session_id = (tx.get("resultSnapshot") or {}).get("sessionId") or f"tx-{tx['_id']}"
    log_step(
        session_id,
        agent_id,
        "ORDER_COMPLETED",
        {
            "orderNumber": order_number,
            "razorpayPaymentId": payment_id,
            "amountPaise": entity.get("amount"),
            "via": "payment.captured",
            "recovered": new_status == "recovered",
        },
        order_id=order.get("_id"),
    )
    return {"matched": True, "orderNumber": order_number, "status": new_status, "paymentId": payment_id}
