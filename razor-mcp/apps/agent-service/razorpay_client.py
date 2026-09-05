"""Razorpay TEST-mode client wrapper.

ALL Razorpay integrations here use TEST MODE credentials — no real funds move.
The SDK calls are real API calls; the keys come from the environment. When keys
are missing/placeholder the wrapper raises RazorpayNotConfigured instead of
fabricating responses — no mocked business logic, no fake order ids.

Production note (queue seam): the calls below are made synchronously inside the
caller's request path for this build. In production, wrap order/link creation in
a transactional-outbox + background worker so an external API call never runs
inside a Mongo transaction's snapshot window.
"""
from typing import Any

import razorpay
from razorpay import errors as rzp_errors

from config import config

# SDK error surface differs across majors (1.x: RazorpayError base; 2.x:
# BadRequestError/GatewayError/ServerError). Normalize to one catchable tuple so
# the wrapper works with either pinned range.
_RZP_ERROR_CLASSES = tuple(
    cls
    for cls in (
        getattr(rzp_errors, "RazorpayError", None),
        getattr(rzp_errors, "BadRequestError", None),
        getattr(rzp_errors, "GatewayError", None),
        getattr(rzp_errors, "ServerError", None),
    )
    if isinstance(cls, type) and issubclass(cls, BaseException)
) or (Exception,)


class RazorpayNotConfigured(Exception):
    """Raised when TEST-mode keys are absent — callers degrade gracefully."""


class RazorpayCallFailed(Exception):
    """Raised when the Razorpay API rejects a call (real API, real error)."""

    def __init__(self, operation: str, detail: Any) -> None:
        super().__init__(f"RAZORPAY_{operation.upper()}_FAILED: {detail}")
        self.operation = operation
        self.detail = detail


_client: razorpay.Client | None = None


def _get_client() -> razorpay.Client:
    global _client
    if not config.razorpay_configured:
        raise RazorpayNotConfigured(
            "RAZORPAY_NOT_CONFIGURED: set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET (TEST MODE keys)"
        )
    if _client is None:
        _client = razorpay.Client(key_id=config.RAZORPAY_KEY_ID, key_secret=config.RAZORPAY_KEY_SECRET)
    return _client


def is_configured() -> bool:
    return config.razorpay_configured


def create_test_order(amount_paise: int, receipt: str, notes: dict[str, Any] | None = None) -> dict[str, Any]:
    """Create a Razorpay TEST-mode order. Returns {'id': 'order_...', ...}."""
    try:
        client = _get_client()
        return client.order.create(
            {
                "amount": int(amount_paise),  # integer paise — never floats
                "currency": "INR",
                "receipt": receipt,
                "notes": notes or {},
            }
        )
    except RazorpayNotConfigured:
        raise
    except _RZP_ERROR_CLASSES as err:
        raise RazorpayCallFailed("order", err) from err


# ---------------------------------------------------------------------------
# v2 BYOK — per-user TEST keys (stored Fernet-encrypted by auth_service)
# ---------------------------------------------------------------------------

def create_order_with_keys(
    key_id: str,
    key_secret: str,
    amount_paise: int,
    receipt: str,
    notes: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a Razorpay order with the USER's own TEST keys (BYOK mode)."""
    try:
        client = razorpay.Client(key_id=key_id, key_secret=key_secret)
        return client.order.create(
            {
                "amount": int(amount_paise),
                "currency": "INR",
                "receipt": receipt[:40],
                "notes": notes or {},
            }
        )
    except _RZP_ERROR_CLASSES as err:
        raise RazorpayCallFailed("order_byok", err) from err


def checkout_signature(key_secret: str, razorpay_order_id: str, razorpay_payment_id: str) -> str:
    """Razorpay checkout verification: HMAC-SHA256(order_id|payment_id, key_secret).

    The key_secret is the HMAC KEY (per Razorpay docs), not part of the payload.
    """
    import hmac
    import hashlib

    payload = f"{razorpay_order_id}|{razorpay_payment_id}"
    return hmac.new(key_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def create_payment_link(
    amount_paise: int,
    reference_id: str,
    description: str,
    expire_by_epoch: int | None = None,
) -> dict[str, Any]:
    """Create an alternative Payment Link (recovery flow). Returns {'id','url'}."""
    try:
        client = _get_client()
        payload: dict[str, Any] = {
            "amount": int(amount_paise),
            "currency": "INR",
            "reference_id": reference_id,
            "description": description[:250],
        }
        if expire_by_epoch:
            payload["expire_by"] = int(expire_by_epoch)
        entity = client.payment_link.create(payload)
        return {"id": entity.get("id", ""), "url": entity.get("short_url") or entity.get("url", "")}
    except RazorpayNotConfigured:
        raise
    except _RZP_ERROR_CLASSES as err:
        raise RazorpayCallFailed("payment_link", err) from err


def verify_webhook_signature(raw_body: bytes, signature: str) -> bool:
    """HMAC-SHA256 of the RAW request body against RAZORPAY_WEBHOOK_SECRET.

    Constant-time comparison via hmac.compare_digest — verified BEFORE the body
    is ever parsed or persisted.
    """
    import hmac
    import hashlib

    if not config.RAZORPAY_WEBHOOK_SECRET or "XXXX" in config.RAZORPAY_WEBHOOK_SECRET:
        # No secret configured -> signature verification cannot pass. Reject rather
        # than accept unsigned (fail-closed, never fail-open).
        return False
    expected = hmac.new(
        config.RAZORPAY_WEBHOOK_SECRET.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature or "")
