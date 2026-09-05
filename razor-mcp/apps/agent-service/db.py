"""PyMongo connection — raw driver, explicit handles (no Flask-Mongoengine).

The cluster is a single-node replica set (rs0) so multi-document ACID
transactions work: wallet debit + transaction insert + order update commit or
roll back together.
"""
import time
import random

from pymongo import MongoClient
from pymongo.database import Database

from config import config

_client: MongoClient | None = None
_db: Database | None = None


def connect_db(retries: int = 30) -> Database:
    """Connect with retry/backoff; survives Mongo's replica-set election window."""
    global _client, _db
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            _client = MongoClient(
                config.MONGODB_URI,
                serverSelectionTimeoutMS=5000,
                tz_aware=True,  # returned datetimes are UTC-aware (comparable with datetime.now(timezone.utc))
            )
            # Default db from the URI path (razormcp), with an explicit fallback.
            _db = _client.get_default_database("razormcp")
            _db.command({"ping": 1})
            print(f"[agent-service] mongo connected (attempt {attempt})")
            return _db
        except Exception as err:  # noqa: BLE001 - retry any boot-time failure
            last_err = err
            _client = None
            _db = None
            backoff_ms = min(500 * 2 ** (attempt - 1), 5000) * random.uniform(0.85, 1.15)
            print(
                f"[agent-service] mongo connect attempt {attempt}/{retries} failed "
                f"({type(err).__name__}) — retrying in {backoff_ms:.0f}ms"
            )
            time.sleep(backoff_ms / 1000.0)
    raise last_err if last_err else RuntimeError("mongo connect failed")


def get_db() -> Database:
    if _db is None:
        raise RuntimeError("DB_NOT_CONNECTED")
    return _db


def get_client() -> MongoClient:
    if _client is None:
        raise RuntimeError("DB_NOT_CONNECTED")
    return _client


def is_connected() -> bool:
    try:
        return _db is not None and _db.command({"ping": 1}).get("ok") == 1
    except Exception:  # noqa: BLE001
        return False


# --- Collection handles (single source of truth for names) ---

def wallets():
    return get_db()["wallets"]


def transactions():
    return get_db()["transactions"]


def otp_challenges():
    return get_db()["otp_challenges"]


def catalog_items():
    return get_db()["catalog_items"]


def orders():
    return get_db()["orders"]


def webhook_events():
    return get_db()["webhook_events"]


def recovery_sessions():
    return get_db()["recovery_sessions"]


def audit_logs():
    return get_db()["audit_logs"]


def agent_conversations():
    return get_db()["agent_conversations"]

# --- v2: auth / rooms ---
def users():
    return get_db()["users"]

def email_codes():
    return get_db()["email_codes"]
