"""POST /webhooks/razorpay — signature-first, idempotent webhook ingestion.

Contract with Razorpay: verify the HMAC-SHA256 signature on the RAW body, then
process, then answer 200 as fast as possible. Signature mismatch -> 400 with no
side effects. Duplicate dispatch (same event id) -> 200 immediately.
"""
from flask import Blueprint, jsonify, request

from services import webhook_service

webhook_bp = Blueprint("webhooks", __name__, url_prefix="/webhooks")


@webhook_bp.post("/razorpay")
def razorpay_webhook():
    raw_body = request.get_data(cache=True)  # EXACT bytes — signature is over these
    signature = request.headers.get("X-Razorpay-Signature", "")

    try:
        result = webhook_service.handle_webhook(raw_body, signature)
    except webhook_service.SignatureInvalid:
        return jsonify({"error": "SIGNATURE_INVALID"}), 400
    except webhook_service.WebhookError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    except Exception as err:  # noqa: BLE001
        # PRODUCTION: this would go to a dead-letter queue for replay.
        return jsonify({"error": "WEBHOOK_PROCESSING_FAILED", "message": str(err)}), 500

    # 200 for duplicates AND fresh events — Razorpay expects an ack either way.
    return jsonify(result), 200
