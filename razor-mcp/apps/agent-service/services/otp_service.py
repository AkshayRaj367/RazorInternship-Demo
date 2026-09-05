"""OTP gate — human approval for above-guardrail transactions.

Security properties:
  * The 6-digit OTP is bcrypt-hashed BEFORE storage. Plaintext never persists.
  * DEV_MODE=true ONLY: the raw OTP is returned in the API response so the demo
    can complete without SMS/push infra.
    # DEV ONLY: in production this is sent via SMS/push, never returned in the API response.
  * Attempt consumption is ATOMIC ($inc under verified: false), so two
    concurrent verifies cannot both succeed on one challenge.
  * The winner is decided by an atomic conditional $set verified: true — the
    loser gets None and sees 'already_verified'.
  * 3 failed attempts -> the transaction is rejected and the challenge expires
    (TTL index backstop deletes the doc).
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from bson import ObjectId
from pymongo import ReturnDocument

import db
from config import config


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def create_challenge(transaction_id: ObjectId) -> dict[str, Any]:
    """Create the single active challenge for a transaction.

    Returns {'otp': '<plaintext, dev-only>', 'challenge': <doc>}. The plaintext
    OTP exists ONLY in the return value / (DEV_MODE) API response — the database
    keeps the bcrypt hash.
    """
    otp = f"{secrets.randbelow(1000000):06d}"  # 6-digit numeric OTP
    otp_hash = bcrypt.hashpw(otp.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    now = _utcnow()
    expires_at = now + timedelta(seconds=config.OTP_TTL_SECONDS)

    doc = {
        "transactionId": transaction_id,
        "otpHash": otp_hash,
        "attempts": 0,
        "maxAttempts": 3,
        "verified": False,
        "expiresAt": expires_at,  # TTL index (5 min) backstops cleanup
        "createdAt": now,
    }
    db.otp_challenges().delete_many({"transactionId": transaction_id})  # one ACTIVE challenge per tx
    db.otp_challenges().insert_one(doc)
    return {"otp": otp, "challenge": doc}


def verify_and_claim(transaction_id: ObjectId, otp: str) -> tuple[str, dict[str, Any] | None]:
    """Verify an OTP attempt. Returns (outcome, challenge_doc).

    Outcomes:
      'verified'         — hash matched AND this caller atomically claimed it
      'already_verified' — a concurrent/t earlier verify already claimed it
      'wrong'            — hash mismatch, attempts remain
      'max_attempts'     — 3rd failure: challenge is dead, transaction rejected
      'expired'          — challenge TTL elapsed
    """
    challenge = db.otp_challenges().find_one({"transactionId": transaction_id})
    if challenge is None:
        return "expired", None

    if challenge.get("verified"):
        return "already_verified", challenge

    if challenge.get("expiresAt", _utcnow()) <= _utcnow():
        return "expired", challenge

    if not isinstance(otp, str) or not otp.strip().isdigit() or len(otp.strip()) != 6:
        return "wrong", challenge

    # ATOMIC attempt consumption: only one verifier at a time can $inc a
    # not-yet-verified challenge — a duplicate dispatch cannot double-count.
    claimed_attempt = db.otp_challenges().find_one_and_update(
        {"_id": challenge["_id"], "verified": False, "expiresAt": {"$gt": _utcnow()}},
        {"$inc": {"attempts": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if claimed_attempt is None:
        return "expired", challenge

    if bcrypt.checkpw(otp.strip().encode("utf-8"), claimed_attempt["otpHash"].encode("utf-8")):
        winner = db.otp_challenges().find_one_and_update(
            {"_id": claimed_attempt["_id"], "verified": False},
            {"$set": {"verified": True}},
            return_document=ReturnDocument.AFTER,
        )
        if winner is None:
            return "already_verified", claimed_attempt
        return "verified", winner

    if claimed_attempt.get("attempts", 0) >= claimed_attempt.get("maxAttempts", 3):
        return "max_attempts", claimed_attempt
    return "wrong", claimed_attempt


def attempts_left(transaction_id: ObjectId) -> int:
    doc = db.otp_challenges().find_one({"transactionId": transaction_id})
    if doc is None or doc.get("verified"):
        return 0
    return max(0, doc.get("maxAttempts", 3) - doc.get("attempts", 0))
