"""Seed demo wallets — idempotent (existing balances are preserved).

Run standalone:
    python3 apps/agent-service/scripts/seed_wallets.py
(env: MONGODB_URI from the repo-root .env)
"""
import sys
from pathlib import Path

# Allow `python3 scripts/seed_wallets.py` from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
from services import wallet_service  # noqa: E402

WALLETS = [
    ("onyx-agent", 2_000_000),          # Rs 20,000 — Onyx's demo wallet
    ("demo-external-agent", 1_000_000),  # Rs 10,000 — external MCP buyer demo
]


def main() -> None:
    db.connect_db()
    for agent_id, balance_paise in WALLETS:
        doc = wallet_service.ensure_wallet(agent_id, balance_paise)
        print(
            f"[seed_wallets] {agent_id}: balance {doc['balancePaise']}p "
            f"(Rs {doc['balancePaise'] / 100:,.2f}), version {doc['version']}, status {doc['status']}"
        )


if __name__ == "__main__":
    main()
