"""DEV/TEST tool — sign and POST synthetic Razorpay webhooks to agent-service.

This exists so the payment.failed -> recovery and payment.captured -> completion
flows can be exercised WITHOUT the Razorpay dashboard. It is a test CLIENT, not
mocked business logic: it produces a correctly-HMAC-signed payload, and the
server verifies it with the exact same code path as real Razorpay events.

Usage:
    python3 scripts/simulate_webhook.py payment.failed  RZM-000123
    python3 scripts/simulate_webhook.py payment.captured RZM-000123
    python3 scripts/simulate_webhook.py payment_link.paid RZM-000123

Env: MONGODB_URI (to resolve the razorpayOrderId), RAZORPAY_WEBHOOK_SECRET,
AGENT_SERVICE_URL (default http://localhost:5000).
"""
import hashlib
import hmac
import json
import sys
import time
import uuid
from pathlib import Path

import os

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from config import config  # noqa: E402

AGENT_URL = os.environ.get("AGENT_SERVICE_URL", "http://localhost:5000")


def resolve_target(order_number: str) -> dict:
    db.connect_db()
    order = db.orders().find_one({"orderNumber": order_number})
    if order is None:
        raise SystemExit(f"ORDER_NOT_FOUND: {order_number} (seed catalog + run a purchase first)")
    tx = db.transactions().find_one({"orderId": order["_id"]}) or {}
    return {"order": order, "tx": tx}


def build_payload(event: str, order: dict, tx: dict) -> dict:
    payment_id = f"pay_{uuid.uuid4().hex[:14]}"
    base = {
        "event": event,
        "event_id": f"evt_simulate_{uuid.uuid4().hex[:12]}",
        "created_at": int(time.time()),
        "contains": ["payment"],
        "payload": {
            "payment": {
                "entity": {
                    "id": payment_id,
                    "order_id": order.get("razorpayOrderId") or f"order_sim_{order['orderNumber']}",
                    "amount": order.get("totalPaise"),
                    "currency": "INR",
                    "status": "captured" if event == "payment.captured" else "failed",
                    "method": "upi",
                    "email": "agent@razor-mcp.dev",
                }
            }
        },
    }
    if event == "payment.failed":
        # Realistic bank decline fields the recovery agent parses.
        base["payload"]["payment"]["entity"].update(
            {
                "error_description": "Insufficient funds in the source account (simulated bank decline)",
                "error_reason": "insufficient_funds",
                "error_code": "UPI-50",
            }
        )
    if event == "payment_link.paid":
        base["payload"] = {
            "payment_link": {
                "entity": {
                    "id": f"plink_{uuid.uuid4().hex[:10]}",
                    "reference_id": order["orderNumber"],
                    "status": "paid",
                    "amount": order.get("totalPaise"),
                    "payment_id": payment_id,
                }
            }
        }
    return base


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("payment.failed", "payment.captured", "payment_link.paid"):
        raise SystemExit(__doc__)
    event, order_number = sys.argv[1], sys.argv[2]

    if not config.RAZORPAY_WEBHOOK_SECRET or "XXXX" in config.RAZORPAY_WEBHOOK_SECRET:
        raise SystemExit("RAZORPAY_WEBHOOK_SECRET is not set (or is the .env.example placeholder).")

    target = resolve_target(order_number)
    payload = build_payload(event, target["order"], target["tx"])
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(
        config.RAZORPAY_WEBHOOK_SECRET.encode("utf-8"), raw, hashlib.sha256
    ).hexdigest()

    url = f"{AGENT_URL.rstrip('/')}/webhooks/razorpay"
    print(f"[simulate] POST {url}\n[simulate] event={event} order={order_number} sig={signature[:16]}...")
    resp = requests.post(
        url,
        data=raw,
        headers={"Content-Type": "application/json", "X-Razorpay-Signature": signature},
        timeout=20,
    )
    print(f"[simulate] -> HTTP {resp.status_code}: {resp.text}")


if __name__ == "__main__":
    main()
