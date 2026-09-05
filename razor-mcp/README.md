# Razor-MCP Realtime — Autonomous Agentic Commerce Gateway

> **All Razorpay integrations use TEST MODE credentials — no real funds move.**
> **Web search is keyless** (DuckDuckGo → Bing → Yahoo → Google chain + Bing Images). No API keys needed for real-time data.

Razor-MCP Realtime is a five-service monorepo where AI agents (including the built-in
agent **Onyx**) search the **live web for real products with real images**, buy them
with **sandbox (fake) funds** or through **BYOK Razorpay TEST checkout**, execute
payments autonomously **under a hard spending guardrail**, escalate to **OTP gates**
(email for humans, inline for agents), and expose every decision to a refresh-proof,
real-time **RazorSense audit trail** — all behind a **login system that isolates every
account into its own room**.

## What's new in v2 (Realtime)

| Feature | Where |
|---|---|
| 🔎 **Real-time web product search** — real listings, real image URLs, live Indian prices (keyless multi-engine chain, 30-min cache, stable purchasable `webId`s) | `mcp-server` tools `web_search` / `web_product_search` |
| 🖼️ **Product images in chat** — Onyx renders markdown with images; interactive product cards with Buy buttons | `web` `ChatPanel` + `MarkdownText` + `ProductGrid` |
| 🛒 **Buy real web products with fake funds** — mixed carts (local catalog SKUs + webIds) checkout against the sandbox wallet | `mcp-server` `orderService` |
| 🔐 **Login system with separated rooms** — every account (human or agent) is an isolated room: wallet, orders, conversations, audit trail, websocket room | `agent-service` `auth_service` + JWT |
| 👤🤖 **Human vs Agent accounts** — humans verify by email OTP and receive purchase OTPs at their registered inbox; agents are issued a personal **MCP API key** (`rzak_...`) and get OTPs inline in the transaction response (or auto-approved with `AGENT_OTP_MODE=auto`) | `agent-service` `auth_routes` |
| 💳 **BYOK Razorpay** — connect your own `rzp_test_` keys (Fernet-encrypted at rest) and checkouts open the REAL Razorpay TEST modal with signature-verified confirmation; or stay on fake funds | `agent-service` + `web` `SettingsPanel` |
| 🔑 **One-command secret bootstrap** — `scripts/bootstrap.sh` generates every secret (fixes the old placeholder-key 401s) | `scripts/bootstrap.sh` |
| 🩹 **openai/httpx compatibility fix** — `openai==1.55.3` + `httpx==0.27.2` pins | `agent-service/requirements.txt` |

| Service | Stack | Role |
|---|---|---|
| `apps/web` | Next.js 16 (App Router, TS, Tailwind) | Login gate (human/agent), chat with live product images + cards, audit dashboard, BYOK settings |
| `apps/agent-service` | Python 3.11 + Flask (+ PyMongo) | Auth/rooms/JWT, LLM orchestration (Onyx), wallet guardrail engine, OTP gate (email/inline/auto), BYOK Razorpay, webhooks + recovery |
| `apps/mcp-server` | Node 20 + Express (+ Mongoose) | JSON-RPC 2.0 MCP tool interface: catalog + **live web search** + checkout + per-agent API keys |
| `apps/ws-gateway` | Node 20 + Socket.IO | Realtime hub: JWT-authenticated per-room event routing, backlog replay |
| `mongo` | MongoDB 7 (single-node replica set `rs0`) | Shared cluster; transactions enabled (required by the ACID debit + all-or-nothing checkout) |

---

## Run it

```bash
# 1. Bootstrap — generates .env with STRONG RANDOM SECRETS
#    (MCP internal key, API-key salt, WS secret, JWT secret, Fernet key)
./scripts/bootstrap.sh
#    Optionally enter your LLM key when prompted (Groq works great):
#      LLM_API_BASE=https://api.groq.com/openai/v1
#      LLM_MODEL=llama-3.3-70b-versatile
#    SMTP is optional: without it, human OTP codes show in the UI (DEV_MODE).

# 2. One-command bring-up
docker compose up --build
#    -> mongo (replica-set init + all indexes via infra/mongo-init/init.js)
#    -> mcp-server :4000  (seeds catalog + registers the internal API key + web-search chain)
#    -> ws-gateway :4001
#    -> agent-service :5000 (demo wallets + login system)
#    -> web :3000

open http://localhost:3000
```

### First login

The console is now **auth-gated**. Register one of two account types:

**👤 Human** — email + password → 6-digit verification code (emailed when SMTP is
set; shown in the UI in DEV_MODE). Every purchase above the ₹5,000 guardrail sends
an OTP **to your registered email**.

**🤖 Agent** — email + password → instantly verified and issued a **personal MCP API
key** (`rzak_...`, shown once). Use it against the MCP endpoint directly:

```bash
curl -X POST http://localhost:4000/mcp \
  -H "X-API-Key: rzak_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Live web product search with images:
curl -X POST http://localhost:4000/mcp \
  -H "X-API-Key: rzak_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"web_product_search","arguments":{"query":"sony wh-1000xm5"}}}'
```

Agent keys are **room-pinned**: an agent can only create/read orders in its own
room, whatever `buyerAgentId` it passes. Above-limit purchases return the OTP
inline in the response — verify it with `POST /api/transactions/<id>/verify-otp`
(set `AGENT_OTP_MODE=auto` to skip OTPs for agent accounts entirely; humans always
get the gate).

### Rooms & isolation

Every account is one room (`user:<uid>`). That room is the wallet agent id, the
order buyer id, the conversation owner, the audit filter, and the websocket room
prefix (`user:<uid>:<sessionId>` — only JWT holders can join). Two different
accounts never see each other's balances, transcripts, timelines, or orders —
even with a leaked sessionId.

### Payment modes (per account)

| Mode | Behavior |
|---|---|
| **Fake funds (default)** | New accounts start with ₹50,000 sandbox balance (`FAKE_FUNDS_START_PAISE`). Purchases debit the simulated wallet. The old `onyx-agent` demo wallet still works for un-authed curls. |
| **BYOK Razorpay (Settings ⚙)** | Paste your own `rzp_test_` keys (Fernet-encrypted at rest; the secret never returns to the browser). Checkouts create a REAL Razorpay TEST order and open the standard checkout modal (test cards work). Payment is confirmed server-side by HMAC signature verification (`POST /api/transactions/<id>/confirm-payment`) and marked paid with full audit steps. |

### The guardrail (unchanged from v1, still the point)

- Purchases ≤ ₹5,000 (`SPEND_LIMIT_PAISE`) execute autonomously.
- Purchases > ₹5,000 → OTP gate. Humans: emailed. Agents: inline or auto.
- Enforcement lives in `wallet_service.execute_debit` (atomic OCC debit, fresh
  guardrail check per attempt) — the LLM prompt is UX only, never a boundary.

---

## Real-time web search details

- **Providers** (first success wins for `web_search`; parallel + merged for
  `web_product_search`): DuckDuckGo lite, DuckDuckGo HTML, Bing, Yahoo, Google.
  All keyless HTML endpoints; redirects (`bing.com/ck/a?...&u=a1...`,
  `r.search.yahoo.com/...RU=...`) are unwrapped to real URLs.
- **Images**: Bing Images tiles carry `murl` (direct media URL) + `purl` (product
  page). Images are domain-matched to organic results when possible.
- **Cache**: `search_cache` Mongo collection, TTL index (default 30 min). Within
  the cache window, `webId`s stay stable — that's what makes web products
  purchasable (`create_order` items accept `{"webId":"WEB-XXXXXXXX","qty":1}`).
- **Prices**: extracted from titles/snippets (₹/Rs./INR patterns), confidence
  scored by repetition; products without a parsed price are shown (images, links)
  but not purchasable.
- Datacenter IPs get degraded engine results — running from a normal
  home/office connection gives the best product quality. Failures degrade
  gracefully: the local catalog keeps working and the tool returns
  `WEB_SEARCH_UNAVAILABLE` honestly.

## Try it (after login)

- "Search the live web for sony wh-1000xm5 and show me pictures" — real products
  with images and current prices.
- "Buy the Sony WH-1000XM5" (needs the webId; the Buy button does this for you) —
  real product, fake funds, full guardrail + audit.
- "Buy a hoodie under ₹2,000" — classic autonomous happy path.
- "Buy a premium watch for ₹10,000" — OTP guardrail path (email for humans,
  inline for agents).

## MCP tool surface (`POST /mcp`, X-API-Key auth, JSON-RPC 2.0)

| Tool | Description |
|---|---|
| `search_catalog` | Local 20-item catalog (query/category/maxPrice filters) |
| `web_search` | LIVE web search (real titles, URLs, snippets) |
| `web_product_search` | LIVE product search with real images + prices + purchasable webIds |
| `get_item` | Catalog item by sku |
| `create_order` | Atomic order (catalog SKUs and/or webIds) — room-pinned for external keys |
| `get_order_status` | Order status — room-pinned |

REST fallback: `GET /catalog`, `GET /catalog/:sku`, `GET /orders/:orderNumber`,
`POST /orders` (Idempotency-Key header).

## Environment (v2 additions)

See `.env.example` — every v2 variable is documented inline. Highlights:

- `AUTH_JWT_SECRET` (required for login), `CRYPTO_SECRET` (Fernet, BYOK at rest)
- `FAKE_FUNDS_START_PAISE` (default ₹50,000), `AGENT_OTP_MODE` (inline|auto)
- `SMTP_*` (human email OTPs; DEV_MODE fallback otherwise)
- `WEB_SEARCH_ENABLED`, `SEARCH_CACHE_TTL_SECONDS`

All secrets are auto-generated by `./scripts/bootstrap.sh`.

## Compatibility fixes (the two classic bugs)

1. **`Client.__init__() got an unexpected keyword argument 'proxies'`** —
   openai SDK 1.35 + httpx ≥0.28 conflict. Fixed: `openai==1.55.3` +
   `httpx==0.27.2` pins in `apps/agent-service/requirements.txt`. Rebuild with
   `docker compose build agent-service`.
2. **401 / UNAUTHORIZED on catalog tools while the LLM replies fine** — a
   placeholder `MCP_SERVER_INTERNAL_API_KEY`. Fixed by `bootstrap.sh` (real
   random key, same .env read by every service).

## Architecture

Full data-flow narrative + ASCII diagram: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
