"""Central configuration — every variable from the repo-root .env.example.

All Razorpay integrations use TEST MODE credentials only. No real funds move.
"""
import os
from pathlib import Path


def _load_dotenv() -> None:
    """Load the repo-root .env for local dev (docker-compose injects env directly)."""
    try:
        # python-dotenv may not be installed in a bare environment; degrade silently.
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover
        return
    here = Path(__file__).resolve().parent  # apps/agent-service
    repo_root = here.parent.parent  # razor-mcp/
    candidates = [Path.cwd() / ".env", repo_root / ".env", here / ".env"]
    for c in candidates:
        if c.exists():
            load_dotenv(dotenv_path=str(c), override=False)
            return


_load_dotenv()


def _bool(val: str | None, default: bool = False) -> bool:
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _int(val: str | None, default: int) -> int:
    try:
        return int(val) if val is not None else default
    except (TypeError, ValueError):
        return default


class Config:
    """Process-wide configuration (read once, referenced everywhere)."""

    def __init__(self) -> None:
        # --- Database ---
        self.MONGODB_URI: str = os.environ.get(
            "MONGODB_URI", "mongodb://localhost:27017/razormcp?replicaSet=rs0&directConnection=true"
        )

        # --- Razorpay (TEST MODE ONLY) ---
        self.RAZORPAY_KEY_ID: str = os.environ.get("RAZORPAY_KEY_ID", "")
        self.RAZORPAY_KEY_SECRET: str = os.environ.get("RAZORPAY_KEY_SECRET", "")
        self.RAZORPAY_WEBHOOK_SECRET: str = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")

        # --- MCP server ---
        self.MCP_SERVER_URL: str = os.environ.get("MCP_SERVER_URL", "http://localhost:4000")
        # Server-side only. NEVER sent to the browser.
        self.MCP_SERVER_INTERNAL_API_KEY: str = os.environ.get("MCP_SERVER_INTERNAL_API_KEY", "")

        # --- ws-gateway ---
        self.WS_GATEWAY_URL: str = os.environ.get("WS_GATEWAY_URL", "http://localhost:4001")
        self.INTERNAL_WS_SECRET: str = os.environ.get("INTERNAL_WS_SECRET", "")

        # --- Guardrail (UPI reserve simulation) ---
        # Rs 5,000 default. <= limit executes autonomously; > limit needs human OTP.
        self.SPEND_LIMIT_PAISE: int = _int(os.environ.get("SPEND_LIMIT_PAISE"), 500_000)
        self.OTP_TTL_SECONDS: int = _int(os.environ.get("OTP_TTL_SECONDS"), 300)
        self.RECOVERY_SESSION_TTL_SECONDS: int = _int(os.environ.get("RECOVERY_SESSION_TTL_SECONDS"), 1800)

        # --- Dev conveniences (never in production) ---
        # DEV_MODE=true returns the generated OTP in the API response for demos.
        self.DEV_MODE: bool = _bool(os.environ.get("DEV_MODE"), True)
        self.SEED_WALLETS: bool = _bool(os.environ.get("SEED_WALLETS"), True)

        # --- LLM (Onyx intent parsing ONLY — never a security boundary) ---
        self.LLM_API_KEY: str = os.environ.get("LLM_API_KEY", "")
        self.LLM_API_BASE: str = os.environ.get("LLM_API_BASE", "https://api.openai.com/v1")
        self.LLM_MODEL: str = os.environ.get("LLM_MODEL", "gpt-4o-mini")

        # --- Auth / rooms (v2) ---
        # JWT signing secret for human+agent logins (shared with ws-gateway).
        self.AUTH_JWT_SECRET: str = os.environ.get("AUTH_JWT_SECRET", "")
        self.AUTH_JWT_TTL_HOURS: int = _int(os.environ.get("AUTH_JWT_TTL_HOURS"), 72)
        # Fernet key (32 url-safe base64 chars) encrypting per-user Razorpay keys.
        self.CRYPTO_SECRET: str = os.environ.get("CRYPTO_SECRET", "")
        # Sandbox starting balance for every new account (paise). Default Rs 50,000.
        self.FAKE_FUNDS_START_PAISE: int = _int(os.environ.get("FAKE_FUNDS_START_PAISE"), 5_000_000)
        # Agent OTP delivery: 'inline' (OTP returned in the tool/API response for
        # the agent to verify itself) or 'auto' (above-limit agent purchases are
        # auto-approved; humans ALWAYS email-OTP regardless of this flag).
        self.AGENT_OTP_MODE: str = os.environ.get("AGENT_OTP_MODE", "inline")

        # --- SMTP (human email OTP; unset -> DEV_MODE returns codes inline) ---
        self.SMTP_HOST: str = os.environ.get("SMTP_HOST", "")
        self.SMTP_PORT: int = _int(os.environ.get("SMTP_PORT"), 587)
        self.SMTP_USER: str = os.environ.get("SMTP_USER", "")
        self.SMTP_PASSWORD: str = os.environ.get("SMTP_PASSWORD", "")
        self.SMTP_FROM: str = os.environ.get("SMTP_FROM", "razor-mcp@localhost")
        self.SMTP_USE_TLS: bool = _bool(os.environ.get("SMTP_USE_TLS"), True)

        # --- Service ---
        self.AGENT_PORT: int = _int(os.environ.get("AGENT_PORT"), 5000)

        # --- Wallet engine tuning (spec: 5 attempts, base 20ms, factor 2, ±30% jitter) ---
        self.WALLET_MAX_ATTEMPTS: int = 5
        self.WALLET_BACKOFF_BASE_MS: float = 20.0
        self.WALLET_BACKOFF_FACTOR: float = 2.0
        self.WALLET_BACKOFF_JITTER: float = 0.30

    @property
    def razorpay_configured(self) -> bool:
        """True only when real (non-placeholder) TEST-mode keys are present."""
        k, s = self.RAZORPAY_KEY_ID, self.RAZORPAY_KEY_SECRET
        if not k or not s:
            return False
        # Placeholders from .env.example are not credentials.
        return "XXXX" not in k and "XXXX" not in s

    @property
    def llm_configured(self) -> bool:
        return bool(self.LLM_API_KEY) and "XXXX" not in self.LLM_API_KEY

    @property
    def auth_configured(self) -> bool:
        """True when a JWT secret is set (login system active)."""
        return bool(self.AUTH_JWT_SECRET) and len(self.AUTH_JWT_SECRET) >= 16

    @property
    def smtp_configured(self) -> bool:
        return bool(self.SMTP_HOST) and bool(self.SMTP_USER)

    @property
    def crypto_configured(self) -> bool:
        return bool(self.CRYPTO_SECRET)

    @property
    def agent_otp_auto(self) -> bool:
        return self.AGENT_OTP_MODE.strip().lower() == "auto"


config = Config()
