import { db } from "@/lib/db";
import type { Wallet, Product, Order } from "@prisma/client";
import type { WalletView, PolicyDecision, PolicyRule } from "./types";

export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function walletView(w: Wallet): WalletView {
  const effective = effectiveLimitPaise(w);
  return {
    balancePaise: w.balancePaise,
    monthlyBudgetPaise: w.monthlyBudgetPaise,
    spentThisMonthPaise: w.spentThisMonthPaise,
    remainingBudgetPaise: Math.max(0, w.monthlyBudgetPaise - w.spentThisMonthPaise),
    budgetUsedPct: Math.round((w.spentThisMonthPaise / w.monthlyBudgetPaise) * 100),
    trustScore: w.trustScore,
    baseLimitPaise: w.baseLimitPaise,
    effectiveLimitPaise: effective,
    label: w.label,
  };
}

/**
 * Adaptive auto-approve limit: every 25 trust points adds ₹500,
 * hard-capped at base + ₹2,000. Trust grows when OTP challenges are
 * completed successfully and shrinks on failures/abuse. Server-side only.
 */
export function effectiveLimitPaise(w: Wallet): number {
  const bonus = Math.floor(w.trustScore / 25) * 50000;
  return w.baseLimitPaise + Math.min(bonus, 200000);
}

const RISK_CATEGORY_CAP_Paise = 800000; // ₹8,000
const VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const VELOCITY_MAX_ORDERS = 3;

interface PolicyInput {
  amountPaise: number;
  product: Pick<Product, "category" | "name" | "sku">;
}

export async function evaluatePolicy(input: PolicyInput): Promise<PolicyDecision> {
  const wallet = await db.wallet.findFirst();
  if (!wallet) throw new Error("wallet not found");

  const recentOrders = await db.order.findMany({
    where: { createdAt: { gte: new Date(Date.now() - VELOCITY_WINDOW_MS) } },
  });
  const wv = walletView(wallet);
  const rules: PolicyRule[] = [];
  let declineCode: PolicyDecision["declineCode"];

  // 1. Wallet balance — hard floor
  if (input.amountPaise > wallet.balancePaise) {
    rules.push({
      id: "sufficient_funds",
      label: "Wallet balance",
      status: "trigger",
      detail: `Order ${rupees(input.amountPaise)} exceeds wallet balance ${rupees(wallet.balancePaise)}.`,
    });
    declineCode = "INSUFFICIENT_FUNDS";
  } else {
    rules.push({
      id: "sufficient_funds",
      label: "Wallet balance",
      status: "pass",
      detail: `${rupees(wallet.balancePaise)} available vs ${rupees(input.amountPaise)} requested.`,
    });
  }

  // 2. Budget pacing — monthly spend runway
  const projected = wallet.spentThisMonthPaise + input.amountPaise;
  if (projected > wallet.monthlyBudgetPaise) {
    rules.push({
      id: "budget_pacing",
      label: "Budget pacing",
      status: "trigger",
      detail: `Would reach ${rupees(projected)} of the ${rupees(wallet.monthlyBudgetPaise)} monthly budget — over by ${rupees(projected - wallet.monthlyBudgetPaise)}.`,
    });
    if (!declineCode) declineCode = "BUDGET_EXCEEDED";
  } else {
    const usedPct = Math.round((projected / wallet.monthlyBudgetPaise) * 100);
    rules.push({
      id: "budget_pacing",
      label: "Budget pacing",
      status: usedPct >= 80 ? "info" : "pass",
      detail: `Projected month-to-date spend ${rupees(projected)} — ${usedPct}% of budget (${rupees(wv.remainingBudgetPaise)} runway left).`,
    });
  }

  // 3. Velocity — orders in the last 10 minutes
  const velocityCount = recentOrders.filter((o) => o.status !== "DECLINED").length;
  if (velocityCount >= VELOCITY_MAX_ORDERS) {
    rules.push({
      id: "velocity",
      label: "Velocity control",
      status: "trigger",
      detail: `${velocityCount} paid/pending orders in the last 10 minutes — exceeds the burst cap of ${VELOCITY_MAX_ORDERS}.`,
    });
    if (!declineCode) declineCode = "VELOCITY_LIMIT";
  } else {
    rules.push({
      id: "velocity",
      label: "Velocity control",
      status: "pass",
      detail: `${velocityCount}/${VELOCITY_MAX_ORDERS} orders in the 10-minute window.`,
    });
  }

  if (declineCode) {
    return {
      decision: "DECLINED",
      declineCode,
      reason: explainDecline(declineCode),
      rules,
      appliedLimitPaise: wv.effectiveLimitPaise,
    };
  }

  // 4. Auto-approve limit (trust-adaptive)
  const withinLimit = input.amountPaise <= wv.effectiveLimitPaise;
  rules.push({
    id: "auto_approve_limit",
    label: "Auto-approve limit",
    status: withinLimit ? "pass" : "trigger",
    detail: withinLimit
      ? `${rupees(input.amountPaise)} is within the trust-adjusted limit of ${rupees(wv.effectiveLimitPaise)} (base ${rupees(wallet.baseLimitPaise)} + trust bonus).`
      : `${rupees(input.amountPaise)} exceeds the trust-adjusted limit of ${rupees(wv.effectiveLimitPaise)} (base ${rupees(wallet.baseLimitPaise)} + trust bonus) — escalation required.`,
  });

  // 5. Category risk — premium electronics get OTP even under the limit
  const riskyCategory = ["watches", "audio"].includes(input.product.category);
  const categoryTrigger = riskyCategory && input.amountPaise > RISK_CATEGORY_CAP_Paise;
  if (riskyCategory) {
    rules.push({
      id: "category_risk",
      label: "Category risk",
      status: categoryTrigger ? "trigger" : "pass",
      detail: categoryTrigger
        ? `High-value ${input.product.category} item above ${rupees(RISK_CATEGORY_CAP_Paise)} — OTP required regardless of limit.`
        : `${input.product.category} item is under the ${rupees(RISK_CATEGORY_CAP_Paise)} high-value threshold.`,
    });
  }

  if (!withinLimit || categoryTrigger) {
    return {
      decision: "OTP_REQUIRED",
      reason: `Amount ${rupees(input.amountPaise)} ${!withinLimit ? "exceeds the auto-approve limit" : "trips a category-risk rule"} — an OTP to the registered device is required before funds move.`,
      rules,
      appliedLimitPaise: wv.effectiveLimitPaise,
    };
  }

  return {
    decision: "AUTO_APPROVED",
    reason: `Within the trust-adjusted limit (${rupees(wv.effectiveLimitPaise)}), budget runway healthy, no velocity flags — auto-approved and captured server-side.`,
    rules,
    appliedLimitPaise: wv.effectiveLimitPaise,
  };
}

function explainDecline(code: NonNullable<PolicyDecision["declineCode"]>): string {
  switch (code) {
    case "INSUFFICIENT_FUNDS":
      return "Declined: wallet balance is insufficient for this order. Top up the wallet or pick a lower-value item.";
    case "BUDGET_EXCEEDED":
      return "Declined: this purchase would breach the monthly budget ceiling. Raise the budget or wait for the next cycle.";
    case "VELOCITY_LIMIT":
      return "Declined: too many orders in a short burst (velocity control). The agent can retry after the 10-minute window cools down.";
  }
}
