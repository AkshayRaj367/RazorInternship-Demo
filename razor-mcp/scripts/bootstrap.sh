#!/usr/bin/env bash
# =============================================================================
# razor-mcp bootstrap — one command before `docker compose up`.
#
#   ./scripts/bootstrap.sh            # generate .env with strong random secrets
#   ./scripts/bootstrap.sh --force    # overwrite an existing .env
#
# What it does:
#   1. Copies .env.example -> .env (never overwriting unless --force).
#   2. GENERATES every secret that caused the classic 401s when left as
#      'change-me-...': MCP_SERVER_INTERNAL_API_KEY, MCP_API_KEY_SALT,
#      INTERNAL_WS_SECRET, AUTH_JWT_SECRET, CRYPTO_SECRET (real Fernet key).
#   3. Optionally prompts for LLM_API_KEY (Groq/OpenAI-compatible) + SMTP.
#
# The old bug — "Groq responds but tools fail with 401" — was exactly a
# placeholder MCP_SERVER_INTERNAL_API_KEY. After this script, that cannot
# happen: the same generated key is read by every service from .env.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; DIM=$'\033[2m'; RESET=$'\033[0m'

say() { printf "%s%s%s\n" "$CYAN" "$1" "$RESET"; }
ok()  { printf "%s✔ %s%s\n" "$GREEN" "$1" "$RESET"; }
warn(){ printf "%s%s%s\n" "$YELLOW" "$1" "$RESET"; }

if [[ -f .env && "${1:-}" != "--force" ]]; then
  warn ".env already exists — keeping it (use --force to regenerate)."
  exit 0
fi

if [[ ! -f .env.example ]]; then
  echo "FATAL: .env.example not found. Run this from the repo root." >&2
  exit 1
fi

cp .env.example .env
say "Fresh .env created from .env.example"

gen_hex() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | xxd -p | tr -d '\n'; }

replace() { # replace <key> <value>
  python3 - "$1" "$2" .env << 'PYEOF'
import re, sys
key, value, path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: text = f.read()
text = re.sub(rf"(?m)^{re.escape(key)}=.*$", f"{key}={value}", text, count=1)
with open(path, "w") as f: f.write(text)
PYEOF
}

# --- generate the secrets that MUST NOT stay as placeholders ---------------
INTERNAL_KEY="rzint_$(gen_hex 20)"
JWT_SECRET="$(gen_hex 32)"
WS_SECRET="$(gen_hex 24)"
API_SALT="$(gen_hex 24)"
FERNET_KEY="$(python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())' 2>/dev/null || echo "")"

replace MCP_SERVER_INTERNAL_API_KEY "$INTERNAL_KEY"
replace MCP_API_KEY_SALT "$API_SALT"
replace INTERNAL_WS_SECRET "$WS_SECRET"
replace AUTH_JWT_SECRET "$JWT_SECRET"
if [[ -n "$FERNET_KEY" ]]; then
  replace CRYPTO_SECRET "$FERNET_KEY"
else
  warn "cryptography not available locally — CRYPTO_SECRET left empty (BYOK keys fall back to a JWT-derived key)."
fi
ok "Generated: MCP internal key, API-key salt, WS secret, JWT secret$( [[ -n "$FERNET_KEY" ]] && echo ', Fernet key' )"

# --- interactive bits (safe to skip with Enter) -----------------------------
printf "\n%sLLM provider (any OpenAI-compatible: Groq, OpenAI, GLM, Ollama...)%s\n" "$BOLD" "$RESET"
read -r -p "  LLM_API_KEY [skip]: " LLM_KEY
if [[ -n "$LLM_KEY" ]]; then
  replace LLM_API_KEY "$LLM_KEY"
  read -r -p "  LLM_API_BASE [https://api.groq.com/openai/v1]: " LLM_BASE
  LLM_BASE="${LLM_BASE:-https://api.groq.com/openai/v1}"
  replace LLM_API_BASE "$LLM_BASE"
  read -r -p "  LLM_MODEL [llama-3.3-70b-versatile]: " LLM_MODEL
  replace LLM_MODEL "${LLM_MODEL:-llama-3.3-70b-versatile}"
  ok "LLM configured"
else
  warn "LLM_API_KEY skipped — Onyx chat will reply with a setup hint until you add it."
fi

printf "\n%sSMTP for human email OTPs (optional — unset returns codes in DEV_MODE)%s\n" "$BOLD" "$RESET"
read -r -p "  SMTP_HOST [skip]: " SMTP_HOST
if [[ -n "$SMTP_HOST" ]]; then
  replace SMTP_HOST "$SMTP_HOST"
  read -r -p "  SMTP_USER: " SMTP_USER; replace SMTP_USER "$SMTP_USER"
  read -r -s -p "  SMTP_PASSWORD: " SMTP_PASS; echo; replace SMTP_PASSWORD "$SMTP_PASS"
  read -r -p "  SMTP_FROM [$SMTP_USER]: " SMTP_FROM; replace SMTP_FROM "${SMTP_FROM:-$SMTP_USER}"
  ok "SMTP configured — human OTPs will be emailed"
else
  warn "SMTP skipped — human OTP codes appear in the UI (DEV_MODE) and server logs."
fi

printf "\n%sEverything else (ports, spend limit Rs 5,000, fake funds Rs 50,000) keeps defaults.%s\n" "$DIM" "$RESET"
printf "\nNext:\n"
printf "  %sdocker compose up --build%s\n" "$BOLD" "$RESET"
printf "  → http://localhost:3000  (register a HUMAN or AGENT account)\n\n"
ok "bootstrap complete"
