import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rupees } from "@/lib/agent/policy";

export async function GET() {
  const [orders, policyEvents, campaigns, wallet] = await Promise.all([
    db.order.findMany({ include: { items: { include: { product: true } } }, orderBy: { createdAt: "desc" } }),
    db.auditEvent.findMany({ where: { type: "POLICY" }, orderBy: { createdAt: "desc" } }),
    db.campaign.findMany(),
    db.wallet.findFirst(),
  ]);

  const paid = orders.filter((o) => o.status === "PAID");
  const primaryPaid = paid.filter((o) => o.items[0]?.role !== "upsell");
  const upsellPaid = paid.filter((o) => o.items[0]?.role === "upsell");

  const revenuePaise = primaryPaid.reduce((s, o) => s + o.totalPaise, 0);
  const upsellRevenuePaise = upsellPaid.reduce((s, o) => s + o.totalPaise, 0);
  const aovPaise = primaryPaid.length ? Math.round(revenuePaise / primaryPaid.length) : 0;
  const attachRate = primaryPaid.length
    ? Math.round((upsellPaid.length / primaryPaid.length) * 100)
    : 0;

  const offeredEvents = await db.auditEvent.findMany({ where: { type: "UPSELL_OFFERED" } });
  const acceptedEvents = await db.auditEvent.findMany({ where: { type: "UPSELL_ACCEPTED" } });
  const declinedEvents = await db.auditEvent.findMany({ where: { type: "DECLINED" } });
  const otpVerified = await db.auditEvent.findMany({ where: { type: "OTP_VERIFIED" } });
  const otpFailed = await db.auditEvent.findMany({ where: { type: "OTP_FAILED" } });
  const offerConversion = offeredEvents.length ? Math.round((acceptedEvents.length / offeredEvents.length) * 100) : 0;
  const otpCompletion = otpVerified.length + otpFailed.length
    ? Math.round((otpVerified.length / (otpVerified.length + otpFailed.length)) * 100)
    : 100;

  // decision funnel from POLICY audits
  const funnel = { AUTO_APPROVED: 0, OTP_REQUIRED: 0, DECLINED: 0 };
  for (const e of policyEvents) funnel[e.decision as keyof typeof funnel] = (funnel[e.decision as keyof typeof funnel] ?? 0) + 1;

  // declined reasons
  const declineReasons: Record<string, number> = {};
  for (const o of orders.filter((o) => o.status === "DECLINED")) {
    if (o.declineCode) declineReasons[o.declineCode] = (declineReasons[o.declineCode] ?? 0) + 1;
  }

  // revenue over time — hourly buckets for the live demo feel
  const now = Date.now();
  const buckets: { label: string; revenuePaise: number; upsellPaise: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const hStart = new Date(now - (i + 1) * 3600_000);
    const hEnd = new Date(now - i * 3600_000);
    const inWindow = paid.filter((o) => o.createdAt >= hStart && o.createdAt < hEnd);
    buckets.push({
      label: `${hEnd.getHours().toString().padStart(2, "0")}:00`,
      revenuePaise: inWindow.filter((o) => o.items[0]?.role !== "upsell").reduce((s, o) => s + o.totalPaise, 0),
      upsellPaise: inWindow.filter((o) => o.items[0]?.role === "upsell").reduce((s, o) => s + o.totalPaise, 0),
    });
  }

  const categoryMix: Record<string, number> = {};
  for (const o of paid) {
    for (const it of o.items) categoryMix[it.product.category] = (categoryMix[it.product.category] ?? 0) + it.unitPaise;
  }

  return NextResponse.json({
    stats: {
      revenuePaise,
      upsellRevenuePaise,
      totalRevenuePaise: revenuePaise + upsellRevenuePaise,
      ordersCount: paid.length,
      paidPrimary: primaryPaid.length,
      aovPaise,
      attachRate,
      offerConversion,
      otpCompletion,
      trustScore: wallet?.trustScore ?? 0,
      declined: orders.filter((o) => o.status === "DECLINED").length,
      walletBalancePaise: wallet?.balancePaise ?? 0,
    },
    funnel,
    declineReasons,
    buckets,
    categoryMix,
    campaigns: campaigns.map((c) => ({
      name: c.name, status: c.status, impressions: c.impressions,
      conversions: c.conversions, incrementalPaise: c.incrementalPaise,
      cvr: c.impressions ? Math.round((c.conversions / c.impressions) * 100) : 0,
    })),
    recentOrders: orders.slice(0, 12).map((o) => ({
      shortId: o.shortId,
      status: o.status,
      declineCode: o.declineCode,
      totalPaise: o.totalPaise,
      role: o.items[0]?.role ?? "primary",
      items: o.items.map((i) => `${i.qty}× ${i.product.name}`),
      paymentRef: o.paymentRef,
      at: o.createdAt.toISOString(),
      revenue: rupees(o.totalPaise),
    })),
  });
}
