# Onyx Upgrade — beyond the threshold check

This package upgrades your razor-mcp project on two axes from the hackathon
brief *"AI Growth & Agentic Commerce — every money action explainable, bounded
and gated"*:

1. **Intelligence**: a policy *stack* + revenue-growth engines (upsell,
   campaigns, insights) replacing the single ₹5,000 threshold.
2. **UI**: a modern Razorpay-style dark interface ("Onyx") with inline
   tool-call cards, a device simulator for OTPs, merchant dashboard and a
   full audit trail.

Everything here runs **end-to-end in two ways**:

- **A. Standalone demo (recommended first)** — the `web/` folder is a complete
  self-contained Next.js app (chat + simulated agent + policy engine + demo
  data). Run it, demo it, iterate on it with zero wiring.
- **B. Drop-in upgrade for your existing services** — the `apps/` folder
  contains TypeScript tools for your mcp-server and a new system prompt for
  your Flask agent-service, wired to your existing Mongo + Razorpay test keys.

---

## A. Run the standalone Onyx demo

The `web/` folder contains the full source (Next.js 16 + TypeScript +
Tailwind + shadcn/ui + Prisma/SQLite).

```bash
# inside a fresh Next.js + shadcn project (or your apps/web after merging):
npm i            # deps: prisma, input-otp, lucide-react, sonner (shadcn components assumed)
npx prisma db push
npx tsx prisma/seed.ts   # or: bun prisma/seed.ts
npm run dev
```

What's inside `web/`:

| Path | What it is |
|---|---|
| `src/components/onyx/app.tsx` | Shell: sidebar, header, device-simulator bell, tab state |
| `src/components/onyx/chat.tsx` | Chat with inline tool-call cards + OTP input |
| `src/components/onyx/panels.tsx` | Catalog, Campaigns, Insights, Audit panels + wallet rail |
| `src/components/onyx/shared.tsx` | Cards, status chips, mini markdown renderer |
| `src/lib/agent/policy.ts` | The policy stack (funds → budget → velocity → trust limit → category risk) |
| `src/lib/agent/upsell.ts` | Upsell engine (margin × rating ranking, −10% bundle) |
| `src/lib/agent/campaigns.ts` | Campaign apply/attribute logic |
| `src/lib/agent/engine.ts` | The simulated agent: intents, checkout, OTP, upsell |
| `src/app/api/*` | chat / catalog / campaigns / insights / audit / device / wallet routes |
| `prisma/schema.prisma` + `prisma/seed.ts` | Catalog (20 SKUs w/ margin+compat edges), wallet, campaign |

The simulated agent implements the SAME decision semantics as the drop-in
tools, so the demo behavior and the production behavior match.

---

## B. Wire the upgrade into your existing razor-mcp services

### 1. mcp-server (Node/TS) — register the new tools

Copy the four files into `apps/mcp-server/src/tools/`:

```
policyEngine.ts          → tool: evaluate_policy
upsellEngine.ts          → tool: recommend_upsells
campaignOrchestrator.ts  → tools: list_campaigns, create_campaign
merchantInsights.ts      → HTTP GET /insights (and optional MCP tool)
```

Each file exports a pure core (e.g. `evaluatePolicy()`) plus an MCP schema +
handler sketch. Register them the same way your existing `search_catalog`
and `checkout_and_pay` are registered — the pure functions are
framework-independent; only the thin wrapper at the bottom of each file
needs adapting to your JSON-RPC/REST dispatch style.

What they need from your Mongo collections:

- `wallets` → add fields if missing: `monthlyBudgetPaise`, `spentThisMonthPaise`,
  `trustScore` (0-100), `baseLimitPaise` (500000)
- `products` → add `marginPct`, `rating`, `compatibleWith` (comma SKU list)
- `campaigns` → new collection (shape is in campaignOrchestrator.ts)
- `auditEvents` → log types: POLICY, CHECKOUT, OTP_SENT, OTP_VERIFIED,
  OTP_FAILED, PAYMENT_CAPTURED, DECLINED, UPSELL_OFFERED, UPSELL_ACCEPTED,
  UPSELL_DECLINED, CAMPAIGN_APPLIED, CAMPAIGN_CREATED

Keep your internal API key auth (`MCP_SERVER_INTERNAL_API_KEY`) on the new
routes too — same as today.

### 2. agent-service (Flask) — swap the system prompt

Replace your current system prompt with
`apps/agent-service/prompts/system-prompt.md`. It teaches the agent the
purchase protocol (search → campaigns → **evaluate_policy** → branch on
decision → upsell) and the exact guardrail facts it must state when asked.
Add the new tool names to your tool registry so the LLM can call them.

### 3. Keep your existing pieces

- `checkout_and_pay` stays — but now it must consume the `evaluate_policy`
  result instead of doing its own ₹5,000 check, and create orders in
  AWAITING_OTP for OTP_REQUIRED decisions (funds held, 10-min TTL, 3 attempts).
- Razorpay test keys: still optional for the OTP-gated flow (simulated
  capture), required for real under-limit captures — exactly as today.

### 4. Frontend

Either point your users at the standalone Onyx app, or port the components
from `web/src/components/onyx/` into your `apps/web` (Next.js) — the chat
panel talks to a single `POST /api/chat` endpoint, so adapting your agent
proxy is a small change. The device-simulator bell polls `GET /api/device`
for OTP SMS.

---

## The demo

`docs/DEMO-SCRIPT.md` is a timed 90-second walkthrough that hits the brief's
bar exactly: explainable decisions, bounded spending, gated releases, the
audit trail, and one failure (VELOCITY_LIMIT) handled gracefully with
zero funds moved.
