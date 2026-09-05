// Shared types for the Onyx agentic commerce engine

export interface WalletView {
  balancePaise: number;
  monthlyBudgetPaise: number;
  spentThisMonthPaise: number;
  remainingBudgetPaise: number;
  budgetUsedPct: number;
  trustScore: number;
  baseLimitPaise: number;
  effectiveLimitPaise: number;
  label: string;
}

export interface ProductLite {
  sku: string;
  name: string;
  category: string;
  pricePaise: number;
  marginPct: number;
  stock: number;
  rating: number;
}

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

export type ToolName =
  | "search_catalog"
  | "campaign.apply"
  | "policy.evaluate"
  | "checkout_and_pay"
  | "verify_otp"
  | "budget.status"
  | "orders.list"
  | "campaigns.list"
  | "upsell.recommend";

export type ToolStatus = "ok" | "awaiting_otp" | "failed" | "declined" | "info";

export interface ToolCall {
  tool: ToolName;
  status: ToolStatus;
  summary: string;
  data?: Record<string, unknown>;
}

export interface UpsellOfferItem {
  product: ProductLite;
  originalPaise: number;
  bundlePaise: number;
  reason: string;
}

export interface UpsellOffer {
  sourceOrderId: string;
  sourceSku: string;
  sourceName: string;
  items: UpsellOfferItem[];
  expiresInSec: number;
}

export interface OtpPending {
  orderId: string;
  orderShortId: string;
  amountPaise: number;
  expiresAt: string;
  maskedDevice: string;
}

export interface OrderLite {
  shortId: string;
  status: string;
  declineCode?: string | null;
  totalPaise: number;
  itemCount: number;
  role: string;
  createdAt: string;
  firstItemName: string;
}

export interface AgentResponse {
  assistantText: string;
  toolCalls: ToolCall[];
  wallet: WalletView;
  otpPending: OtpPending | null;
  upsellOffer: UpsellOffer | null;
  orders: OrderLite[];
}
