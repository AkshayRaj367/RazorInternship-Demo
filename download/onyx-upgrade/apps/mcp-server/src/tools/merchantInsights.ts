/**
 * Merchant Insights — proves the agent GROWS revenue, not just processes it.
 * Aggregates paid orders, upsell attribution, OTP outcomes and campaign lift
 * from your existing Mongo collections. Wire as an HTTP GET (dashboard) and
 * optionally as an MCP tool so the agent can report metrics in chat.
 */

export interface OrderLike {
  status: string; // PAID | AWAITING_OTP | DECLINED
  declineCode?: string | null;
  totalPaise: number;
  createdAt: Date;
  items: Array<{ role: string; unitPaise: number; product: { category: string } }>;
}

export interface AuditLike {
  type: string; // UPSELL_OFFERED | UPSELL_ACCEPTED | OTP_VERIFIED | OTP_FAILED | ...
}

export interface MerchantInsights {
  stats: {
    revenuePaise: number;          // paid primary orders
    upsellRevenuePaise: number;    // paid upsell orders — agent-grown
    totalRevenuePaise: number;
    ordersCount: number;
    aovPaise: number;
    attachRatePct: number;         // % of primary orders with an upsell
    offerConversionPct: number;    // accepted / offered
    otpCompletionPct: number;      // verified / (verified + failed)
    declinedCount: number;
  };
  declineReasons: Record<string, number>;
  funnel: { AUTO_APPROVED: number; OTP_REQUIRED: number; DECLINED: number };
}

export function computeInsights(orders: OrderLike[], audits: AuditLike[]): MerchantInsights {
  const paid = orders.filter((o) => o.status === "PAID");
  const primary = paid.filter((o) => o.items[0]?.role !== "upsell");
  const upsells = paid.filter((o) => o.items[0]?.role === "upsell");

  const revenue = primary.reduce((s, o) => s + o.totalPaise, 0);
  const upsellRevenue = upsells.reduce((s, o) => s + o.totalPaise, 0);

  const offered = audits.filter((a) => a.type === "UPSELL_OFFERED").length;
  const accepted = audits.filter((a) => a.type === "UPSELL_ACCEPTED").length;
  const otpOk = audits.filter((a) => a.type === "OTP_VERIFIED").length;
  const otpFail = audits.filter((a) => a.type === "OTP_FAILED").length;

  // Decision funnel from your POLICY audit events (count by decision field)
  const funnel = { AUTO_APPROVED: 0, OTP_REQUIRED: 0, DECLINED: 0 };
  for (const o of orders) {
    if (o.status === "PAID" && o.items[0]?.role !== "upsell") funnel.AUTO_APPROVED++;
    else if (o.status === "AWAITING_OTP") funnel.OTP_REQUIRED++;
    else if (o.status === "DECLINED") funnel.DECLINED++;
  }

  const declineReasons: Record<string, number> = {};
  for (const o of orders.filter((x) => x.status === "DECLINED")) {
    if (o.declineCode) declineReasons[o.declineCode] = (declineReasons[o.declineCode] ?? 0) + 1;
  }

  return {
    stats: {
      revenuePaise: revenue,
      upsellRevenuePaise: upsellRevenue,
      totalRevenuePaise: revenue + upsellRevenue,
      ordersCount: paid.length,
      aovPaise: primary.length ? Math.round(revenue / primary.length) : 0,
      attachRatePct: primary.length ? Math.round((upsells.length / primary.length) * 100) : 0,
      offerConversionPct: offered ? Math.round((accepted / offered) * 100) : 0,
      otpCompletionPct: otpOk + otpFail ? Math.round((otpOk / (otpOk + otpFail)) * 100) : 100,
      declinedCount: orders.filter((o) => o.status === "DECLINED").length,
    },
    declineReasons,
    funnel,
  };
}
