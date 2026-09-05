"""Transaction endpoints — the money-movement API.

Every write goes through the same guardrailed engine as Onyx:
  POST /api/transactions/execute       @require_idempotency_key (reusable decorator)
  POST /api/transactions/<id>/verify-otp   the human/agent approval gate
  POST /api/transactions/<id>/confirm-payment  BYOK Razorpay checkout signature verify
  GET  /api/transactions?agentId=...       recent history (WalletBadge/debug)

v2: when an Authorization: Bearer JWT is present, the caller's room becomes
the transaction room (agent_id = user:<uid>) and OTP delivery/payment mode
follow the account type.
"""
from flask import Blueprint, jsonify, request

from routes.auth_routes import require_auth
from services import auth_service, transaction_service
from services.wallet_service import WalletError

transaction_bp = Blueprint("transactions", __name__, url_prefix="/api/transactions")


@transaction_bp.post("/execute")
@transaction_service.require_idempotency_key
def execute(idempotency_key: str):
    body = request.get_json(silent=True) or {}
    agent_id = body.get("agentId")
    session_id = body.get("sessionId")
    items = body.get("items")

    # v2: an authed caller is pinned to their own room.
    user = None
    try:
        user = auth_service.user_from_token(request.headers.get("Authorization"))
        agent_id = auth_service.room_agent_id(user)
    except auth_service.AuthError:
        pass  # legacy demo mode

    try:
        response = transaction_service.execute_transaction(
            agent_id=agent_id,
            session_id=session_id,
            items=items,
            idempotency_key=idempotency_key,
            source="api",
            user=user,
        )
    except transaction_service.TransactionError as err:
        return jsonify({"error": err.code, "message": str(err), "data": err.data}), err.http_status
    except WalletError as err:
        return jsonify({"error": err.code, "message": str(err)}), 400

    # 202 Accepted: the OTP path is awaiting human verification (no debit yet).
    status_code = 202 if response.get("status") == "awaiting_otp" else 200
    return jsonify(response), status_code


@transaction_bp.post("/<transaction_id>/verify-otp")
def verify_otp(transaction_id: str):
    body = request.get_json(silent=True) or {}
    otp = body.get("otp")
    session_hint = body.get("sessionId", "")
    if not isinstance(otp, str):
        return jsonify({"error": "INVALID_OTP", "hint": "otp (6-digit string) is required."}), 400

    try:
        response, status_code = transaction_service.verify_otp(transaction_id, otp, session_hint)
    except transaction_service.TransactionError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status
    except WalletError as err:
        return jsonify({"error": err.code, "message": str(err)}), 400

    return jsonify(response), status_code


@transaction_bp.post("/<transaction_id>/confirm-payment")
def confirm_payment(transaction_id: str):
    """BYOK Razorpay checkout completion — verifies the payment signature with
    the USER's stored key_secret and marks the transaction + order paid."""
    body = request.get_json(silent=True) or {}
    razorpay_payment_id = body.get("razorpay_payment_id")
    razorpay_order_id = body.get("razorpay_order_id")
    signature = body.get("razorpay_signature")

    if not all(isinstance(v, str) and v.strip() for v in (razorpay_payment_id, razorpay_order_id, signature)):
        return jsonify(
            {
                "error": "INVALID_PAYMENT_CONFIRMATION",
                "hint": "razorpay_payment_id, razorpay_order_id, razorpay_signature are required.",
            }
        ), 400

    try:
        response, status_code = transaction_service.confirm_byok_payment(
            transaction_id, razorpay_payment_id.strip(), razorpay_order_id.strip(), signature.strip()
        )
    except transaction_service.TransactionError as err:
        return jsonify({"error": err.code, "message": str(err)}), err.http_status

    return jsonify(response), status_code


@transaction_bp.get("")
def list_for_agent():
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
