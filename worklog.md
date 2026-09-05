# Worklog

---
Task ID: 1
Agent: main (Super Z)
Task: Upgrade the user's razor-mcp agentic-commerce project beyond a single threshold check with a modern Razorpay-like UI (hackathon brief: AI Growth & Agentic Commerce)

Work Log:
- Loaded fullstack-dev skill, initialized Next.js 16 + TypeScript + Tailwind + shadcn environment
- Designed Prisma schema (SQLite): Product (margin/stock/rating/compat edges), Wallet (budget, trust score, adaptive limit), Order/OrderItem, OtpChallenge, Campaign, AuditEvent; seeded 20 SKUs + wallet ₹18,000/trust 60 + "Weekend Watch Fest" 15% campaign
- Built policy stack engine (src/lib/agent/policy.ts): sufficient funds → budget pacing → velocity (3/10min) → trust-adaptive auto-approve limit (base ₹5,000 + bonus capped +₹2,000) → category risk (watches/audio > ₹8,000 → OTP); every decision returns rule-by-rule explainability
- Built upsell engine (margin × rating × stock ranking, −10% bundle), campaign orchestrator (impressions/conversions/incremental attribution), merchant insights aggregation
- Built simulated agent engine (src/lib/agent/engine.ts): intent parsing (buy/budget/orders/offers/OTP/upsell-accept/decline/help), full checkout branches (AUTO_APPROVE capture / OTP hold with device SMS / graceful declines with next steps)
- API routes: chat, catalog (agent-readable view), campaigns (GET/POST/PATCH), insights, audit (filterable), device simulator (OTP SMS), wallet
- Built Onyx UI (Razorpay-style dark navy #02042B + electric gradient #00C2FF→#4A6CFF): sidebar shell, chat with inline tool-call cards (search/policy/checkout/campaign/upsell), OTP banner with input-otp, device-simulator bell, wallet rail with trust meter, catalog with agent-view JSON peek, campaign launcher, insights dashboard (stat cards, revenue stream, decision funnel, ledger), audit timeline with payloads
- Verified end-to-end with agent-browser: landing → watch purchase → OTP via device bell → verify (trust 60→68) → upsell accept → insights/audit/campaigns tabs → campaign creation; fixed insights route Set(number) bug and mobile overflow (min-w-0/break-words); lint clean
- Packaged download/onyx-upgrade.zip: drop-in mcp-server TS tools (policyEngine, upsellEngine, campaignOrchestrator, merchantInsights), Flask system prompt upgrade, 90-sec demo script, full web UI source + integration README

Stage Summary:
- Live app: Onyx agentic-commerce demo at preview (chat + policy cards + OTP device simulator + upsell + campaigns + insights + audit)
- Deliverable: /home/z/my-project/download/onyx-upgrade.zip (27 files) for merging into the user's D:\College Projects\RazorInternship\razor-mcp repo
- All backend flows curl- and browser-verified: OTP flow, auto-approve, velocity graceful failure, campaign attribution, trust adaptation

---
Task ID: 2
Agent: main (Super Z)
Task: razor-mcp v2 "Realtime" — live-web product data, web-search agent with real images, login system with human/agent split + separated rooms, BYOK Razorpay with fake-funds fallback, split OTP delivery (email for humans / inline for agents)

Work Log:
- Read the full razor-mcp codebase (agent-service Flask, mcp-server Express, ws-gateway, Next.js web, shared-types)
- shared-types: added web.ts (WebProduct/WebResult contracts), MCP_TOOLS web_search + web_product_search, TOOL_SCHEMAS + verify_purchase_otp, order items support webId, OrderItem web snapshot fields
- mcp-server NEW realtimeSearchService.ts: keyless multi-engine chain (DDG lite/HTML, Bing w/ ck/a redirect unwrap, Yahoo w/ RU= unwrap, Google fallback), Bing Images (murl/purl parsing), INR price extraction, Mongo search_cache (TTL 30min, stable webIds), in-flight dedup, parallel+merged product search with shopping-domain scoring
- mcp-server: tools.webSearch/tools.webProductSearch, room-scoped createOrder/getOrderStatus (callerRoom pinning for external agent keys), internalRoute POST /internal/clients (agent-key registration, timing-safe), orderService web items (no stock management, snapshot price-lock, mixed carts), searchCache model
- agent-service NEW auth_service.py (register/login/verify, bcrypt, HS256 JWT, Fernet BYOK storage, MCP key issuance rzak_*), email_service.py (smtplib, HTML templates, graceful dev fallback), routes/auth_routes.py (/api/auth/*)
- agent-service: agent_routes authed chat/me/wallet-me, transaction_service v2 (user context, OTP split delivery: human email/agent inline/auto, BYOK payment branch + confirm_byok_payment HMAC verify, sandbox-capture when no server Razorpay keys — fake funds work with zero config), llm_orchestrator 7 tools incl. web tools, conversation/audit room scoping, razorpay_client per-user keys, requirements httpx 0.27.2 + openai 1.55.3 fix
- ws-gateway: node:crypto HS256 JWT verify (no new dep), authed rooms user:<uid>:<sessionId>, room-filtered backlogs, legacy joins excluded from authed entries
- web: AuthContext + LoginScreen (human/agent tabs, devCode step, MCP key reveal + curl cheat-sheet), ChatContext (auth room, products from toolCalls, Razorpay checkout.js + confirm-payment), MarkdownText (sanitized mini-markdown w/ images), ProductGrid (real image cards + Buy), SettingsPanel (BYOK connect/disconnect, key regen), WalletBadge /me, proxies forward Authorization, useSocket token join
- Infra: .env.example v2 vars, scripts/bootstrap.sh (auto-generates all secrets — fixes the classic 401), mongo-init users/email_codes/search_cache indexes, README rewrite, web build pinned to --webpack (Turbopack internal error workaround)
- VERIFIED live: 19/19 e2e (register→devCode→JWT→room wallet ₹50k, agent MCP key→tools/list, live web_search via agent key, sandbox purchase paid w/o razorpay keys + wallet debit, human OTP devCode (no inline), agent INLINE otp, BYOK connect/disconnect/live-key rejection, conversation isolation); ws room test all-pass; web-order pipeline 8/8 (webId resolve, web orders, room isolation, buyer pinning, internal path, mixed carts, stock untouched by web items); web build OK

Stage Summary:
- Deliverable: /home/z/my-project/download/razor-mcp-realtime.zip (148 files, 252K) — full upgrade, drop-in replacement for the razor-mcp repo
- Setup: ./scripts/bootstrap.sh && docker compose up --build → http://localhost:3000
- Datacenter-IP note: search engines degrade results from this sandbox; user's home/office IP gets full-quality DDG/Bing products
