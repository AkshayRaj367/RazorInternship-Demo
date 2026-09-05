# Onyx — 90-second demo script (hits the brief's bar)

The brief: *"Every money action explainable, bounded and gated. Show the audit
trail and one failure handled gracefully."*

## Setup (before judges arrive)

- Stack running (`docker compose up`), Onyx web UI open, chat tab focused.
- Fresh state (wallet ₹18,000 · trust 60 · auto-approve ₹6,000).
- Campaign tab visible in another tab / ready to switch.

## The script

**0:00 — Frame it.** "This is a shopping agent with a policy stack, not a
threshold check — and it earns revenue for the merchant, it doesn't just
process payments."

**0:05 — The headline flow: "Buy a premium watch for ₹10,000".**
Watch the tool cards cascade in chat:
1. `search_catalog` — finds the Chrono Premier (SKU, price, margin, stock).
2. Campaign applies — Weekend Watch Fest −15% → ₹8,500 as a visible line item.
3. `policy.evaluate` — the money moment: five rules, pass/trigger line by line
   (budget pacing ₹13,350 of ₹25,000 · velocity 0/3 · auto-approve ₹6,000
   exceeded · category risk triggered).
4. Checkout → **funds held, not released**. OTP "sent" to registered device.

**0:25 — The device.** Open the bell (device simulator) — the SMS is there
with the code. Read it, enter it in the OTP field, hit Verify.
→ Payment captured, `rzp_test_...` ref, **trust score 60 → 68** and the
auto-approve limit visibly rises. Adaptive trust, not a static number.

**0:40 — Revenue growth.** The agent immediately offers the Milano strap at
−10% bundle price — ranked by **margin × rating**. Click add. Then point at
Insights: "Agent-grown revenue ₹1,349, attach rate 100% — that's revenue the
agent created, and it's audited."

**0:55 — The failure, handled gracefully.** Buy 2 more small items fast, then
a third — the policy card shows **VELOCITY_LIMIT**, funds untouched, and the
agent explains the cooldown. "No funds moved" is the line judges remember.

**1:10 — Audit trail tab.** Every money action in one timeline: policy
evaluations with full rule payloads, OTP sent/verified, captures, declines,
upsell offers/accepts, campaign attribution. Click any row → raw JSON payload.
"Every rupee has a paper trail."

**1:20 — Close.** "Explainable — rule-by-rule cards. Bounded — budget, velocity,
trust-capped limits. Gated — OTP before funds move. And it grows the merchant,
not just the wallet. On Razorpay test mode end to end."

## One-liners that land

- "Funds are held, never released, until the human says so."
- "The agent can't talk its way past the guardrails — they're server-side."
- "That strap wasn't upsold by a script — it was ranked by merchant margin."
- "Declines are features: velocity control just stopped a card-testing burst."
