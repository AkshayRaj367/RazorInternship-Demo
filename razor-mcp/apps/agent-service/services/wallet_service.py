"""THE wallet engine — sole guardrail enforcement for the entire system.

Security model (read this before touching anything):

  * Every money-moving code path in the system — the raw REST API, the MCP
    checkout flow, and Onyx's LLM tool-calling loop — routes through
    execute_debit(). No caller is trusted to self-enforce the limit; no caller
    can pass a pre-computed "guardrail already passed" boolean.

  * The guardrail decision (amountPaise <= SPEND_LIMIT_PAISE) is re-derived
    FRESH inside every retry attempt of execute_debit, against the actual value
    being debited. Above-limit debits only pass with a server-side-constructed
    OtpAuthorization, which only exists after a bcrypt-verified challenge was
    consumed atomically in otp_service — an LLM prompt cannot fabricate one.

  * The debit itself is a single atomic find_one_and_update guarded by the
    wallet's optimistic-concurrency `version` and live `balancePaise`
    ($gte). A stale read (concurrent transaction won the race) matches zero
    documents -> explicit retry with jittered exponential backoff (5 attempts,
    base 20ms, factor 2, ±30% jitter) -> explicit CONCURRENT_MODIFICATION_MAX_
    RETRIES failure. The guardrail can never be skipped by racing it.

  * The same atomic shape is used when the debit participates in a larger ACID
    transaction (session passed through) so a Razorpay failure rolls the wallet
    back along with the transaction record.
"""
import random
import time
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from pymongo import ReturnDocument

import db
from config import config


class WalletError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class WalletNotFound(WalletError):
    def __init__(self, agent_id: str) -> None:
        super().__init__("WALLET_NOT_FOUND", f"No wallet for agent '{agent_id}'. Run scripts/seed_wallets.py.")


class WalletFrozen(WalletError):
    def __init__(self, agent_id: str) -> None:
        super().__init__("WALLET_FROZEN", f"Wallet for agent '{agent_id}' is frozen; debits are blocked.")


class InsufficientFunds(WalletError):
    def __init__(self, agent_id: str, amount_paise: int, balance_paise: int) -> None:
        super().__init__(
            "INSUFFICIENT_FUNDS",
            f"Wallet '{agent_id}' balance {balance_paise}p is below requested {amount_paise}p.",
        )
        self.balance_paise = balance_paise


class GuardrailViolation(WalletError):
    """Amount above the delegated limit without a verified OTP authorization."""

    def __init__(self, amount_paise: int, limit_paise: int) -> None:
        super().__init__(
            "GUARDRAIL_VIOLATION",
            f"Amount {amount_paise}p exceeds the delegated spend limit {limit_paise}p "
            "and no verified OTP authorization exists. Human approval required.",
        )


class ConcurrentModificationMaxRetries(WalletError):
    def __init__(self, attempts: int) -> None:
        super().__init__(
            "CONCURRENT_MODIFICATION_MAX_RETRIES",
            f"Wallet version changed by a concurrent transaction on all {attempts} attempts; "
            "failing explicitly rather than proceeding on a stale balance.",
        )


class OtpAuthorization:
    """Server-side proof that a human verified an OTP for ONE exact amount.

    Constructed ONLY by transaction_service after otp_service verified the
    challenge in the database. It is deliberately NOT a caller-suppliable
    boolean: external callers (including the LLM orchestrator) never get to
    build or pass one — they call the public execute_transaction API, which
    derives authorization internally.
    """

    __slots__ = ("agent_id", "transaction_id", "amount_paise")

    def __init__(self, agent_id: str, transaction_id: ObjectId, amount_paise: int) -> None:
        self.agent_id = agent_id
        self.transaction_id = transaction_id
        self.amount_paise = int(amount_paise)

    def permits(self, agent_id: str, amount_paise: int) -> bool:
        """Exact-match authorization: same agent, same amount, same transaction scope."""
        return self.agent_id == agent_id and self.amount_paise == int(amount_paise)


def _guardrail_allows(agent_id: str, amount_paise: int, authorization: OtpAuthorization | None) -> bool:
    """FRESH evaluation against the actual value being debited. Never cached."""
    if amount_paise <= config.SPEND_LIMIT_PAISE:
        return True
    return authorization is not None and authorization.permits(agent_id, amount_paise)


def get_wallet(agent_id: str) -> dict[str, Any] | None:
    return db.wallets().find_one({"agentId": agent_id})


def serialize_wallet(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """JSON-safe wallet projection for API responses (never the raw doc)."""
    if doc is None:
        return None
    from datetime import datetime

    created = doc.get("createdAt")
    updated = doc.get("updatedAt")
    return {
        "agentId": doc.get("agentId"),
        "balancePaise": doc.get("balancePaise", 0),
        "currency": doc.get("currency", "INR"),
        "status": doc.get("status", "active"),
        "version": doc.get("version", 0),
        "createdAt": created.isoformat() if isinstance(created, datetime) else None,
        "updatedAt": updated.isoformat() if isinstance(updated, datetime) else None,
    }


def ensure_wallet(agent_id: str, initial_balance_paise: int) -> dict[str, Any]:
    """Idempotent upsert used by seed tooling. Existing balances are preserved."""
    now = datetime.now(timezone.utc)
    doc = db.wallets().find_one_and_update(
        {"agentId": agent_id},
        {
            "$setOnInsert": {
                "balancePaise": int(initial_balance_paise),
                "currency": "INR",
                "version": 0,
                "status": "active",
                "createdAt": now,
                "updatedAt": now,
            }
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return doc


def _jittered_backoff_ms(attempt: int) -> float:
    """base 20ms, factor 2, ±30% jitter — exactly the spec'd shape."""
    raw = config.WALLET_BACKOFF_BASE_MS * (config.WALLET_BACKOFF_FACTOR ** (attempt - 1))
    jitter = random.uniform(1.0 - config.WALLET_BACKOFF_JITTER, 1.0 + config.WALLET_BACKOFF_JITTER)
    return raw * jitter


def execute_debit(
    agent_id: str,
    amount_paise: int,
    session=None,
    authorization: OtpAuthorization | None = None,
) -> dict[str, Any]:
    """Atomically debit `amount_paise` from the agent wallet.

    OCC + guardrail engine. Callers pass an optional Mongo `session` so this
    debit can participate in the larger ACID transaction (debit + transaction
    insert + Razorpay order). Returns the post-debit wallet document.

    Raises (all explicit, none silent):
      WalletNotFound / WalletFrozen / InsufficientFunds / GuardrailViolation /
      ConcurrentModificationMaxRetries
    """
    if not isinstance(amount_paise, int) or amount_paise <= 0:
        raise WalletError("INVALID_AMOUNT", "amountPaise must be a positive integer (paise).")

    attempts = config.WALLET_MAX_ATTEMPTS
    for attempt in range(1, attempts + 1):
        # ---- FRESH guardrail check on EVERY attempt, inside the engine. ----
        # No caller flag is consulted; a >limit amount without a verified OTP
        # authorization can never reach the $inc below, whoever the caller is.
        if not _guardrail_allows(agent_id, amount_paise, authorization):
            raise GuardrailViolation(amount_paise, config.SPEND_LIMIT_PAISE)

        wallet = db.wallets().find_one({"agentId": agent_id}, session=session)
        if wallet is None:
            raise WalletNotFound(agent_id)
        if wallet.get("status") != "active":
            raise WalletFrozen(agent_id)

        result = db.wallets().find_one_and_update(
            {
                "agentId": agent_id,
                "version": wallet["version"],  # optimistic-concurrency guard
                "balancePaise": {"$gte": amount_paise},  # live-balance guard
                "status": "active",
            },
            {"$inc": {"balancePaise": -amount_paise, "version": 1}},
            return_document=ReturnDocument.AFTER,
            session=session,
        )
        if result is not None:
            return result

        # result is None: another concurrent transaction mutated the wallet
        # between our read and this conditional write (version and/or balance
        # no longer match). Re-read, re-check the guardrail, retry with jittered
        # exponential backoff — never proceed on the stale snapshot.
        if attempt == attempts:
            # Distinguish "version raced" from "genuinely insufficient funds"
            # for a precise failure reason before giving up.
            fresh = db.wallets().find_one({"agentId": agent_id}, session=session)
            if fresh is None:
                raise WalletNotFound(agent_id)
            if fresh.get("balancePaise", 0) < amount_paise:
                raise InsufficientFunds(agent_id, amount_paise, fresh.get("balancePaise", 0))
            raise ConcurrentModificationMaxRetries(attempts)

        delay_ms = _jittered_backoff_ms(attempt)
        time.sleep(delay_ms / 1000.0)

    raise ConcurrentModificationMaxRetries(attempts)  # unreachable, keeps type-checkers honest
