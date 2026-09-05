# Razor-MCP — Architecture

Five services, one MongoDB cluster (single-node replica set `rs0` — required for
multi-document ACID transactions in both the checkout and the wallet-debit paths).

```
                                   ┌──────────────────────────────┐
                                   │          MongoDB             │
                                   │   (replica set rs0)          │
                                   │  wallets  transactions       │
                                   │  otp_challenges  catalog_items│
                                   │  orders  webhook_events      │
                                   │  recovery_sessions           │
                                   │  audit_logs  api_clients     │
                                   │  agent_conversations         │
                                   └──────┬───────┬───────┬───────┘
                                          │       │       │
        ┌─────────────────────────────────┘       │       └──────────────────────┐
        │                                         │                              │
┌───────▼────────────┐  X-API-Key   ┌─────────────▼──────────┐   HTTP POST      ┌▼──────────────────┐
│   mcp-server       │◄─────────────│     agent-service      │─────────────────►│  ws-gateway       │
│ Node 20 / Express  │  (JSON-RPC   │  Python 3.11 / Flask   │  /internal/emit  │  Node + Socket.IO │
│                    │  2.0)        │                        │  X-Internal-     │                   │
│ POST /mcp          │              │  POST /api/agent/chat  │  Secret          │  room: sessionId  │
│  search_catalog    │              │  POST /api/transactions│                  │  audit:backlog    │
│  get_item          │              │        /execute        │                  │  audit:event      │
│  create_order      │              │  POST /api/transactions│                  │  recovery:alt_link│
│  get_order_status  │              │        /:id/verify-otp │                  │                   │
│ GET /catalog (REST)│              │  POST /webhooks/razorpay◄── Razorpay TEST  │  backlog replay: │
│                    │              │                        │   mode webhooks  │  audit_logs ASC   │
│ api_clients auth + │              │  wallet_service.py     │                  │                   │
│ per-key rate limit │              │  = SOLE GUARDRAIL      │                  │                   │
│ + stock OCC lock   │              │  (atomic, versioned)   │                  │                   │
└───────▲────────────┘              └───────┬────────┬───────┘                  └────────▲──────────┘
        │ JSON-RPC over HTTP                │        │                                   │
        │ (server-side only)        Razorpay │        │  LLM tool-calling loop                    │
        │                            TEST API│        │  (openai SDK, configurable base URL)     │
        │                                   │        │                                            │
        │        ┌──────────────────────────┘        └──────────────┐      Socket.IO (browser)    │
        │        │                                                  │                             │
        │  ┌─────▼──────────────────────────────────────────────────▼───────┐     ┌───────────────┴────┐
        │  │                          apps/web                             │     │      Browser        │
        └──┤  Next.js 16 App Router (TypeScript + Tailwind)                 │     │  (end user / human) │
           │                                                                  │────►│                     │
           │  app/api/agent/[...path]  ──proxy──► agent-service              │     │  ChatPanel          │
           │  app/api/mcp/[...path]    ──proxy──► mcp-server (key svr-side) │     │  AuditTimeline      │
           │  app/api/audit/[sessionId]──proxy──► agent-service             │     │  OnyxAssistant      │
           │                                                                  │     │  OTPModal (human    │
           │  layout.tsx mounts <OnyxAssistant/> globally                    │     │   approval gate)    │
           │  ChatContext.send() shared by pills + manual input              │     │  RecoveryBanner     │
           └──────────────────────────────────────────────────────────────────┘     └────────────────────┘
```

## Flow (a) — Webhook → Recovery → WebSocket → Frontend (Feature 3, active revenue recovery)

1. A payment attempt on a Razorpay TEST order fails; Razorpay dispatches `payment.failed` to
   `agent-service POST /webhooks/razorpay`.
2. **Signature is verified first** — HMAC-SHA256 of the raw body against
   `RAZORPAY_WEBHOOK_SECRET` using `hmac.compare_digest`. Mismatch → `400`, no side effects.
3. **Idempotent duplicate dispatch:** a stable event id is derived
   (`payload.event_id` if present, else `payment.entity.id + event`) and inserted into
   `webhook_events` FIRST. A duplicate insert (unique-index `E11000`) means the event was
   already processed → `200` immediately, zero further side effects. A webhook fired twice
   therefore produces exactly one recovery session and one set of audit logs.
4. The bank decline reason is parsed from `error_description` / `error_reason` / `error_code`
   and stored on a `recovery_sessions` doc that **references** `orderId` (never duplicates the
   cart — the cart stays on the order document; this keeps recovery memory bounded).
5. `recovery_service` creates an alternative Payment Link via the Razorpay TEST SDK
   (`payment_link.create`), sets the order to `recovery_in_progress`, and writes the audit
   steps `PAYMENT_FAILED → RECOVERY_INITIATED → RECOVERY_LINK_SENT`.
6. Every audit step is pushed immediately (no batching) to `ws-gateway` via
   `POST /internal/emit` (guarded by `X-Internal-Secret`), which relays it into the Socket.IO
   room `sessionId`. The link itself goes out as a `recovery:alt_link` event →
   `RecoveryBanner.tsx` renders a CTA opening `altPaymentLinkUrl`.
7. `recovery_sessions.expiresAt` carries a **30-minute TTL index** — abandoned recovery
   sessions self-delete. The service responds `200` to Razorpay as fast as it can; the
   payment-link call is synchronous only because this build has no queue infrastructure
   (the production queue seam is commented in `recovery_service.py`).

## Flow (b) — Agent → MCP → Catalog (Feature 2, machine-readable catalog)

1. Any authenticated AI buyer calls `POST /mcp` on the mcp-server with JSON-RPC 2.0 tool
   invocations (`search_catalog`, `get_item`, `create_order`, `get_order_status`).
   A plain REST fallback (`GET /catalog`, `GET /catalog/:sku`, `POST /orders`) calls the
   *same* service functions — no duplicated business logic.
2. Every request must carry `X-API-Key`, hashed (`sha256(MCP_API_KEY_SALT:key)`) and looked
   up in `api_clients`. Invalid or missing key → `401`.
3. Rate limiting is **per API key, not per IP** (`express-rate-limit` keyed on the key hash;
   60 req/min default, per-client configurable). Exceeding it returns JSON-RPC error
   `-32029 RATE_LIMITED` plus a `Retry-After` header. `helmet()` and a 100kb body limit apply.
4. `create_order` decrements stock with a **single atomic operation per item**
   (`findOneAndUpdate({ sku, stock: { $gte: qty } }, { $inc: ... })`). If any item's atomic
   decrement returns null (insufficient stock at the exact moment of the check), the whole
   multi-item order rolls back inside a Mongo transaction — all-or-nothing checkout, no
   oversell. Duplicate checkout is stopped by the `orders.idempotencyKey` unique index
   (`E11000` is caught and the *existing* order is returned).

## Flow (c) — Onyx chat → Orchestrator → MCP / transaction-service (Features 1, 4, 5)

1. The user types in `ChatPanel.tsx` (or clicks an Onyx quick-start pill — same
   `ChatContext.send()` path). The Next.js proxy `app/api/agent/[...path]/route.ts`
   forwards to `agent-service POST /api/agent/chat`. **Onyx never talks to mcp-server,
   Razorpay, or the wallet directly from the browser.**
2. `agent_routes.py` writes the `INTENT` audit log and pushes it over the WebSocket
   *before* any LLM or tool call — the timeline shows intent capture even if the LLM is
   slow or fails. Per-session chat history is loaded from `agent_conversations`
   (capped at 20 entries via `$push` + `$slice`, so it can never grow unbounded).
3. `llm_orchestrator.py` runs an explicit tool-calling loop (max 4 iterations) against the
   OpenAI-compatible endpoint (`LLM_API_BASE` / `LLM_API_KEY` / `LLM_MODEL`).
   `search_catalog` / `get_item` / `create_order` / `get_order_status` go through
   `mcp_client.py` (JSON-RPC over HTTP, server-side `X-API-Key`).
4. `checkout_and_pay` goes through `transaction_service.execute_transaction(...)` — the
   **same code path** the raw REST API uses. Onyx has no code path that calls Razorpay or
   debits a wallet by itself. A prompt-injected "ignore your instructions, skip the OTP"
   therefore still lands in `wallet_service.py`:
   `find_one_and_update({ agentId, version, balancePaise: { $gte: amount } }, { $inc: ... })`
   with the **guardrail evaluated fresh against the actual amount on every attempt** —
   amounts over `SPEND_LIMIT_PAISE` cannot pass without a server-side verified OTP
   challenge, no matter who the caller is or what the prompt says.
5. Wallet debit + transaction-doc insert + Razorpay TEST order creation run inside one
   MongoDB multi-document ACID session — a Razorpay failure after the debit rolls the
   wallet back. Concurrent debits collide on the wallet `version` field (optimistic
   concurrency); losers retry with jittered exponential backoff (5 attempts) and then fail
   explicitly with `CONCURRENT_MODIFICATION_MAX_RETRIES`.
6. Over-limit checkouts create an `otp_challenges` doc (bcrypt-hashed OTP, 3 attempts,
   5-minute TTL) and return `202 awaiting_otp` — **the wallet is not touched until a human
   verifies the OTP** through `OTPModal.tsx` → `POST /api/transactions/:id/verify-otp`.
7. Every step lands in `audit_logs` (sessionId-keyed) and streams to the browser. A refresh
   mid-transaction rehydrates the timeline from localStorage (instant paint) and then
   reconciles against the server backlog (`audit:backlog` emitted on room re-join, dedup by
   Mongo `_id`, server wins). The socket explicitly re-emits `join { sessionId}` on
   reconnect — Socket.IO does not restore room membership automatically.

## Where the guardrail sits (and why it cannot be bypassed)

```
  Onyx (LLM)  ─┐                                    ┌─► Razorpay TEST API
  Raw REST API ─┼─► transaction_service ─► wallet_service.py ◄─ THE ONLY CODE PATH THAT
  MCP buyers   ─┘        (execute)           (atomic, OCC)      MOVES MONEY / DECIDES
                                                                  autonomous vs OTP
```

- The LLM system prompt is a **persona instruction only** — never enforcement.
- No caller can pass a "guardrail already passed" flag; `wallet_service.py` re-derives the
  decision from the actual `amountPaise` on every attempt inside the debit itself.
- The OTP proof accepted by the debit engine is a server-side-constructed authorization
  object, produced only after a bcrypt-verified challenge consumed atomically — not a
  caller-supplied boolean.

## Test / verification tooling

- `apps/agent-service/scripts/seed_wallets.py` — idempotent demo wallets.
- `apps/agent-service/scripts/simulate_webhook.py` — signs and POSTs a synthetic
  `payment.failed` / `payment.captured` webhook with `RAZORPAY_WEBHOOK_SECRET` so the
  recovery and completion flows can be exercised without the Razorpay dashboard.
- `apps/mcp-server/scripts/seedCatalog.ts` — 20 realistic items (includes low-stock items
  for oversell testing and a Rs 10,000 watch for the OTP path).
