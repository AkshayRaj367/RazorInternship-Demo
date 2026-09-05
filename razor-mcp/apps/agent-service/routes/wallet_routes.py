"""Wallet read endpoints — powers WalletBadge.tsx (balance + status chip)."""
from flask import Blueprint, jsonify

from services import wallet_service
from services.audit_service import serialize

wallet_bp = Blueprint("wallet", __name__, url_prefix="/api/wallet")


@wallet_bp.get("/<agent_id>")
def get_wallet(agent_id: str):
    if len(agent_id) < 2 or len(agent_id) > 128:
        return jsonify({"error": "INVALID_AGENT_ID"}), 400
    doc = wallet_service.get_wallet(agent_id)
    if doc is None:
        return jsonify({"error": "WALLET_NOT_FOUND", "agentId": agent_id}), 404
    return jsonify(serialize(doc))
