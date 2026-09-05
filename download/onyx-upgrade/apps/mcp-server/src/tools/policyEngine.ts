/**
 * Policy Engine — replaces the single ₹5,000 threshold check with an
 * explainable policy stack. Every decision returns the rule-by-rule
 * evaluation so the agent (and the audit trail) can show WHY.
 *
 * Rules (evaluated server-side, in order):
 *   1. sufficient_funds   — wallet balance floor
 *   2. budget_pacing      — monthly budget ceiling, projected pre-purchase
 *   3. velocity           — burst cap: max N paid/pending orders per window
 *   4. auto_approve_limit — trust-adaptive limit (base + trust bonus, capped)
 *   5. category_risk      — high-value watches/audio force OTP even under limit
 *
 * Decision: AUTO_APPROVED | OTP_REQUIRED | DECLINED{code}
 * Decline codes: INSUFFICIENT_FUNDS | BUDGET_EXCEEDED | VELOCITY_LIMIT
 */

export interface PolicyRule {
  id: string;
  label: string;
  status: "pass" | "trigger" | "info";
  detail: string;
}

export interface PolicyDecision {
  decision: "AUTO_APPROVED" | "OTP_REQUIRED" | "DECLINED";
  declineCode?: "INSUFFICIENT_FUNDS" | "BUDGET_EXCEEDED" | "VELOCITY_LIMIT";
  reason: string;
  rules: PolicyRule[];
  appliedLimitPaise: number;
}

export interface WalletDoc {
  balancePaise: number;
  monthlyBudgetPaise: number;
  spentThisMonthPaise: number;
  trustScore: number; // 0-100
  baseLimitPaise: number;
}

export interface OrderDoc {
  status: string; // PAID | AWAITING_OTP | DECLINED | ...
  createdAt: Date;
}

export const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;

const VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const VELOCITY_MAX_ORDERS = 3;
const CATEGORY_RISK_CAP_PAISE = 800000; // ₹8,000
const RISK_CATEGORIES = new Set(["watches", "audio"]);

/** Trust bonus: +₹500 per 25 trust points, hard-capped at +₹2,000. */
export function effectiveLimitPaise(w: WalletDoc): number {
  const bonus = Math.floor(w.trustScore / 25) * 50000;
  return w.baseLimitPaise + Math.min(bonus, 200000);
}

export interface EvaluatePolicyInput {
  amountPaise: number;
  product: { sku: string; name: string; category: string };
  wallet: WalletDoc;
  recentOrders: OrderDoc[]; // orders created in the last 10 minutes
}

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyDecision {
  const { amountPaise, product, wallet, recentOrders } = input;
  const rules: PolicyRule[] = [];
  let declineCode: PolicyDecision["declineCode"];
  const limit = effectiveLimitPaise(wallet);

  // 1 — wallet balance
  if (amountPaise > wallet.balancePaise) {
    rules.push(rule("sufficient_funds", "Wallet balance", "trigger",
      `Order ${rupees(amountPaise)} exceeds wallet balance ${rupees(wallet.balancePaise)}.`));
    declineCode = "INSUFFICIENT_FUNDS";
  } else {
    rules.push(rule("sufficient_funds", "Wallet balance", "pass",
      `${rupees(wallet.balancePaise)} available vs ${rupees(amountPaise)} requested.`));
  }

  // 2 — budget pacing
  const projected = wallet.spentThisMonthPaise + amountPaise;
  if (projected > wallet.monthlyBudgetPaise) {
    rules.push(rule("budget_pacing", "Budget pacing", "trigger",
      `Would reach ${rupees(projected)} of the ${rupees(wallet.monthlyBudgetPaise)} monthly budget.`));
    if (!declineCode) declineCode = "BUDGET_EXCEEDED";
  } else {
    const pct = Math.round((projected / wallet.monthlyBudgetPaise) * 100);
    rules.push(rule("budget_pacing", "Budget pacing", pct >= 80 ? "info" : "pass",
      `Projected month-to-date ${rupees(projected)} — ${pct}% of budget.`));
  }

  // 3 — velocity
  const burst = recentOrders.filter((o) => o.status !== "DECLINED").length;
  if (burst >= VELOCITY_MAX_ORDERS) {
    rules.push(rule("velocity", "Velocity control", "trigger",
      `${burst} orders in the last 10 minutes — burst cap is ${VELOCITY_MAX_ORDERS}.`));
    if (!declineCode) declineCode = "VELOCITY_LIMIT";
  } else {
    rules.push(rule("velocity", "Velocity control", "pass",
      `${burst}/${VELOCITY_MAX_ORDERS} orders in the 10-minute window.`));
  }

  if (declineCode) {
    return { decision: "DECLINED", declineCode, reason: explain(declineCode), rules, appliedLimitPaise: limit };
  }

  // 4 — trust-adaptive auto-approve limit
  const within = amountPaise <= limit;
  rules.push(rule("auto_approve_limit", "Auto-approve limit", within ? "pass" : "trigger",
    within
      ? `${rupees(amountPaise)} is within the trust-adjusted limit of ${rupees(limit)}.`
      : `${rupees(amountPaise)} exceeds the trust-adjusted limit of ${rupees(limit)} — escalation required.`));

  // 5 — category risk
  const risky = RISK_CATEGORIES.has(product.category) && amountPaise > CATEGORY_RISK_CAP_PAISE;
  if (RISK_CATEGORIES.has(product.category)) {
    rules.push(rule("category_risk", "Category risk", risky ? "trigger" : "pass",
      risky
        ? `High-value ${product.category} item above ${rupees(CATEGORY_RISK_CAP_PAISE)} — OTP required regardless of limit.`
        : `${product.category} item is under the ${rupees(CATEGORY_RISK_CAP_PAISE)} high-value threshold.`));
  }

  if (!within || risky) {
    return {
      decision: "OTP_REQUIRED",
      reason: `${rupees(amountPaise)} ${!within ? "exceeds the auto-approve limit" : "trips a category-risk rule"} — OTP to the registered device is required before funds move.`,
      rules, appliedLimitPaise: limit,
    };
  }

  return {
    decision: "AUTO_APPROVED",
    reason: `Within the trust-adjusted limit (${rupees(limit)}), budget runway healthy, no velocity flags — auto-approved server-side.`,
    rules, appliedLimitPaise: limit,
  };
}

/** Trust adaptation hooks — call after OTP success / failure. */
export const TRUST_DELTA = { OTP_VERIFIED: 8, OTP_FAILED: -4 } as const;
export function clampTrust(t: number): number {
  return Math.max(0, Math.min(100, t));
}

function rule(id: string, label: string, status: PolicyRule["status"], detail: string): PolicyRule {
  return { id, label, status, detail };
}

function explain(code: NonNullable<PolicyDecision["declineCode"]>): string {
  switch (code) {
    case "INSUFFICIENT_FUNDS":
      return "Declined: wallet balance is insufficient — top up or choose a lower-value item.";
    case "BUDGET_EXCEEDED":
      return "Declined: this purchase would breach the monthly budget ceiling.";
    case "VELOCITY_LIMIT":
      return "Declined: too many orders in a short burst — retry after the 10-minute window cools down.";
  }
}

/* ------------------------------------------------------------------ */
/* MCP tool registration — adapt the wrapper to your server's style.  */
/* The evaluatePolicy function itself is framework-independent.       */
/* ------------------------------------------------------------------ */
export const policyEngineToolSchema = {
  name: "evaluate_policy",
  description:
    "Evaluate a purchase against the guardrail policy stack (funds, budget pacing, velocity, trust-adaptive limit, category risk). Returns the decision AND the rule-by-rule explanation. Always call this before checkout_and_pay.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sku: { type: "string" },
      amount_paise: { type: "number" },
    },
    required: ["sku", "amount_paise"],
  },
};

export async function policyEngineToolHandler(
  args: { sku: string; amount_paise: number },
  ctx: { getWallet(): Promise<WalletDoc>; getRecentOrders(windowMs: number): Promise<OrderDoc[]>; getProduct(sku: string): Promise<{ sku: string; name: string; category: string }> }
): Promise<PolicyDecision> {
  const [wallet, recentOrders, product] = await Promise.all([
    ctx.getWallet(),
    ctx.getRecentOrders(VELOCITY_WINDOW_MS),
    ctx.getProduct(args.sku),
  ]);
  return evaluatePolicy({ amountPaise: args.amount_paise, product, wallet, recentOrders });
}
