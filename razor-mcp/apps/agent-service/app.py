"""agent-service entrypoint — Flask wiring for every blueprint.

Serves:
  /api/agent/chat           Onyx (INTENT audit -> LLM tool loop)
  /api/agent/conversation/  capped chat history
  /api/wallet/<agentId>     balance/status
  /api/transactions/...     guardrailed money movement + OTP verify
  /webhooks/razorpay        signature-verified, idempotent webhooks
  /api/audit/<sessionId>    timeline hydration fallback
  /health                   liveness (docker healthcheck)

Boot sequence: connect Mongo -> ensure demo wallets -> register blueprints ->
start the stale-transaction janitor (marks expired awaiting_otp/pending BEFORE
the TTL index deletes them, releasing reserved stock) -> serve.

NOTE: the Flask dev server (threaded) is used for this TEST-mode build. In
production run `gunicorn -w 4 -b 0.0.0.0:5000 app:app` (see README).
"""
import threading
import time

from flask import Flask, jsonify
from flask_cors import CORS

import db
from config import config
from routes.agent_routes import agent_bp
from routes.audit_routes import audit_bp
from routes.auth_routes import auth_bp
from routes.transaction_routes import transaction_bp
from routes.wallet_routes import wallet_bp
from routes.webhook_routes import webhook_bp
from services import transaction_service, wallet_service

DEMO_WALLETS = [
    # agentId, initial balance (paise). Idempotent upsert — existing balances kept.
    ("onyx-agent", 2_000_000),        # Rs 20,000 — the demo wallet Onyx spends from
    ("demo-external-agent", 1_000_000),  # Rs 10,000 — external MCP buyer demo
]


def create_app() -> Flask:
    app = Flask(__name__)
    # The Next.js proxy calls server-to-server; CORS is open for /api/* only to
    # keep direct local tooling (curl/Postman from the browser dev tools) working.
    CORS(app, resources={r"/api/*": {"origins": "*"}}, methods=["GET", "POST", "OPTIONS"])

    app.register_blueprint(agent_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(wallet_bp)
    app.register_blueprint(transaction_bp)
    app.register_blueprint(webhook_bp)
    app.register_blueprint(audit_bp)

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "db": db.is_connected(), "service": "agent-service"})

    @app.errorhandler(404)
    def not_found(_err):
        return jsonify({"error": "NOT_FOUND"}), 404

    @app.errorhandler(405)
    def method_not_allowed(_err):
        return jsonify({"error": "METHOD_NOT_ALLOWED"}), 405

    @app.errorhandler(500)
    def server_error(err):  # pragma: no cover
        return jsonify({"error": "INTERNAL_ERROR", "message": str(err)}), 500

    return app


def start_janitor(interval_seconds: int = 60) -> threading.Thread:
    """Expire stuck awaiting_otp / pending transactions before the TTL delete."""

    def loop() -> None:
        while True:
            try:
                expired = transaction_service.expire_stale_transactions()
                if expired:
                    print(f"[agent-service] janitor expired {expired} stale transaction(s)")
            except Exception as err:  # noqa: BLE001
                print(f"[agent-service] janitor error: {err}")
            time.sleep(interval_seconds)

    t = threading.Thread(target=loop, name="tx-janitor", daemon=True)
    t.start()
    return t


def main() -> None:
    db.connect_db()

    if config.SEED_WALLETS:
        for agent_id, balance in DEMO_WALLETS:
            wallet_service.ensure_wallet(agent_id, balance)
        print(f"[agent-service] demo wallets ensured: {[w[0] for w in DEMO_WALLETS]}")

    app = create_app()
    start_janitor()
    print(
        f"[agent-service] listening on :{config.AGENT_PORT} "
        f"(spend limit {config.SPEND_LIMIT_PAISE}p, DEV_MODE={config.DEV_MODE}, "
        f"razorpay configured={config.razorpay_configured}, llm configured={config.llm_configured}, "
        f"auth configured={config.auth_configured}, smtp configured={config.smtp_configured}, "
        f"agent otp mode={config.AGENT_OTP_MODE})"
    )
    # threaded=True: concurrent transaction executions + webhook deliveries.
    app.run(host="0.0.0.0", port=config.AGENT_PORT, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
