import { db } from "@/lib/db";
import type { Product, Order, Wallet } from "@prisma/client";
import { evaluatePolicy, walletView, rupees } from "./policy";
import { recommendUpsells } from "./upsell";
import { applyCampaign, recordCampaignConversion } from "./campaigns";
import type { AgentResponse, ToolCall, OrderLite, UpsellOffer } from "./types";

const MASKED_DEVICE = "+91 ••••• 99413";
const OTP_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- helpers

async function nextShortId(): Promise<string> {
  const count = await db.order.count();
  return `RZM-${String(count + 1).padStart(6, "0")}`;
}

async function audit(
  type: string,
  summary: string,
  opts: { orderId?: string; amountPaise?: number; decision?: string; payload?: unknown } = {}
) {
  await db.auditEvent.create({
    data: {
      type,
      summary,
      orderId: opts.orderId,
      amountPaise: opts.amountPaise,
      decision: opts.decision,
      payload: JSON.stringify(opts.payload ?? {}),
    },
  });
}

async function ordersLite(): Promise<OrderLite[]> {
  const orders = await db.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 6,
    include: { items: { include: { product: true } } },
  });
  return orders.map((o) => ({
    shortId: o.shortId,
    status: o.status,
    declineCode: o.declineCode,
    totalPaise: o.totalPaise,
    itemCount: o.items.reduce((n, i) => n + i.qty, 0),
    role: o.items[0]?.role ?? "primary",
    createdAt: o.createdAt.toISOString(),
    firstItemName: o.items[0]?.product.name ?? "—",
  }));
}

async function otpPending(): Promise<AgentResponse["otpPending"]> {
  const challenge = await db.otpChallenge.findFirst({
    where: { status: "PENDING", expiresAt: { gt: new Date() } },
    include: { order: true },
  });
  if (!challenge) return null;
  return {
    orderId: challenge.orderId,
    orderShortId: challenge.order.shortId,
    amountPaise: challenge.order.totalPaise,
    expiresAt: challenge.expiresAt.toISOString(),
    maskedDevice: MASKED_DEVICE,
  };
}

async function pendingUpsellOffer(): Promise<UpsellOffer | null> {
  // A live offer exists if the latest PAID primary order has no upsell yet
  const lastPrimary = await db.order.findFirst({
    where: { status: "PAID" },
    orderBy: { createdAt: "desc" },
    include: { items: { include: { product: true } } },
  });
  if (!lastPrimary) return null;
  const upsellOrder = await db.order.findFirst({
    where: { status: "PAID", createdAt: { gt: lastPrimary.createdAt } },
  });
  if (upsellOrder) return null;
  const source = lastPrimary.items.find((i) => i.role === "primary")?.product;
  if (!source) return null;
  const offer = await recommendUpsells(source);
  if (!offer) return null;
  return { ...offer, sourceOrderId: lastPrimary.id, sourceSku: source.sku };
}

// ---------------------------------------------------------------- search

interface ParsedBuy {
  keywords: string[];
  maxPricePaise?: number;
  premium: boolean;
}

function parseBuy(text: string): ParsedBuy | null {
  const t = text.toLowerCase();
  if (!/\b(buy|purchase|order|get|add|grab)\b/.test(t) && !/₹|rs\.?\s?\d|under\s+\d/.test(t)) return null;

  let maxPricePaise: number | undefined;
  const under = t.match(/(?:under|below|less than|upto|up to|max(?:imum)?|cheapest.*?)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/);
  const explicit = t.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/);
  const num = (m: RegExpMatchArray | null) => (m ? Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) : undefined);
  if (under) maxPricePaise = num(under);
  else if (explicit) maxPricePaise = num(explicit);

  const stop = new Set([
    "buy", "purchase", "order", "get", "add", "grab", "a", "an", "the", "for", "me", "please",
    "under", "below", "less", "than", "upto", "up", "to", "max", "maximum", "premium", "budget",
    "rs", "inr", "rupees", "want", "need", "would", "like", "some", "good", "best", "nice",
    "and", "of", "in", "with", "watch", "watches", "price", "cost", "costing", "around", "about",
  ]);
  const keywords = t
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w) && !/^\d+$/.test(w));
  return { keywords, maxPricePaise, premium: /\bpremium|flagship|luxury|expensive|high-end|best\b/.test(t) };
}

function scoreProduct(p: Product, parsed: ParsedBuy): number {
  const hay = `${p.name} ${p.category} ${p.tags} ${p.description}`.toLowerCase();
  let score = 0;
  for (const k of parsed.keywords) {
    if (hay.includes(k)) score += k.length >= 5 ? 3 : 2;
    if (p.category === k) score += 2;
  }
  if (parsed.premium) score += p.pricePaise > 500000 ? 2 : 0;
  if (parsed.maxPricePaise && p.pricePaise <= parsed.maxPricePaise) score += 1;
  return score;
}

async function searchProducts(parsed: ParsedBuy): Promise<Product[]> {
  const all = await db.product.findMany({ where: { active: true } });
  const scored = all
    .map((p) => ({ p, s: scoreProduct(p, parsed) }))
    .filter(({ p, s }) => (parsed.keywords.length > 0 ? s > 0 : true) && (!parsed.maxPricePaise || p.pricePaise <= parsed.maxPricePaise!));
  if (parsed.premium) {
    scored.sort((a, b) => b.p.pricePaise - a.p.pricePaise);
  } else {
    scored.sort((a, b) => b.s - a.s || b.p.rating - a.p.rating);
  }
  return scored.slice(0, 3).map((x) => x.p);
}

// ---------------------------------------------------------------- checkout

async function checkout(
  product: Product,
  toolCalls: ToolCall[]
): Promise<{ text: string }> {
  const applied = await applyCampaign(product);
  const subtotal = product.pricePaise;
  const discount = applied?.discountPaise ?? 0;
  const total = subtotal - discount;

  if (applied && discount > 0) {
    toolCalls.push({
      tool: "campaign.apply",
      status: "ok",
      summary: `“${applied.campaign.name}” applied — ${applied.campaign.value}% off ${product.category}`,
      data: { campaign: applied.campaign.name, discountPaise: discount, totalPaise: total },
    });
    await audit("CAMPAIGN_APPLIED", `Campaign “${applied.campaign.name}” applied to ${product.sku} (−${rupees(discount)})`, {
      amountPaise: discount,
      payload: { campaign: applied.campaign.name, scope: applied.campaign.scope },
    });
  }

  const decision = await evaluatePolicy({ amountPaise: total, product });
  toolCalls.push({
    tool: "policy.evaluate",
    status: decision.decision === "DECLINED" ? "declined" : "info",
    summary: decision.reason,
    data: { decision },
  });
  await audit("POLICY", `Policy evaluation for ${product.sku}: ${decision.decision}`, {
    amountPaise: total,
    decision: decision.decision,
    payload: { rules: decision.rules, declineCode: decision.declineCode },
  });

  const shortId = await nextShortId();

  // DECLINED path — graceful failure
  if (decision.decision === "DECLINED") {
    await db.order.create({
      data: {
        shortId,
        status: "DECLINED",
        declineCode: decision.declineCode,
        subtotalPaise: subtotal,
        discountPaise: discount,
        totalPaise: total,
        decision: JSON.stringify(decision),
        items: { create: { productId: product.id, unitPaise: product.pricePaise, role: "primary" } },
      },
    });
    toolCalls.push({
      tool: "checkout_and_pay",
      status: "declined",
      summary: `Order ${shortId} declined — ${decision.declineCode}`,
      data: { shortId, declineCode: decision.declineCode, reason: decision.reason },
    });
    await audit("DECLINED", `Order ${shortId} declined (${decision.declineCode}) for ${product.sku}`, {
      orderId: shortId,
      amountPaise: total,
      decision: "DECLINED",
      payload: { declineCode: decision.declineCode, rules: decision.rules },
    });
    return { text: declineMessage(decision, product, shortId) };
  }

  // OTP path — escalate before funds move
  if (decision.decision === "OTP_REQUIRED") {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const order = await db.order.create({
      data: {
        shortId,
        status: "AWAITING_OTP",
        subtotalPaise: subtotal,
        discountPaise: discount,
        totalPaise: total,
        campaignId: applied?.campaign.id,
        decision: JSON.stringify(decision),
        items: { create: { productId: product.id, unitPaise: product.pricePaise, role: "primary" } },
        otp: {
          create: { code, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
        },
      },
    });
    toolCalls.push({
      tool: "checkout_and_pay",
      status: "awaiting_otp",
      summary: `Order ${shortId} held — ${rupees(total)} reserved, awaiting OTP`,
      data: { shortId, totalPaise: total, status: "AWAITING_OTP", maskedDevice: MASKED_DEVICE },
    });
    await audit("OTP_SENT", `OTP sent to ${MASKED_DEVICE} for order ${shortId}`, {
      orderId: shortId,
      amountPaise: total,
      decision: "OTP_REQUIRED",
      payload: { expiresInMin: 10, challenge: "sms" },
    });
    return {
      text: `**${product.name}** is secured at **${rupees(total)}**${discount ? ` (${applied?.campaign.name}: −${rupees(discount)})` : ""}.\n\nOrder **${shortId}** is reserved but funds are **held, not released** — this purchase trips the guardrails (${whyOtp(decision)}). A one-time password was sent to your registered device ${MASKED_DEVICE}.\n\nOpen the **device simulator** (bell icon, top-right) to read the OTP, then send it here to release the payment. The hold expires in 10 minutes.`,
    };
  }

  // AUTO-APPROVE path — capture immediately
  return captureOrder(shortId, product, subtotal, discount, total, applied?.campaign.id, decision, toolCalls);
}

function whyOtp(d: { rules: { id: string; status: string; label: string }[] }): string {
  const tripped = d.rules.filter((r) => r.status === "trigger").map((r) => r.label.toLowerCase());
  return tripped.length ? tripped.join(" + ") : "amount above auto-approve limit";
}

async function captureOrder(
  shortId: string,
  product: Product,
  subtotal: number,
  discount: number,
  total: number,
  campaignId: string | undefined,
  decision: Awaited<ReturnType<typeof evaluatePolicy>>,
  toolCalls: ToolCall[]
): Promise<{ text: string }> {
  const paymentRef = `rzp_test_${Math.random().toString(36).slice(2, 14)}`;
  const order = await db.order.create({
    data: {
      shortId,
      status: "PAID",
      subtotalPaise: subtotal,
      discountPaise: discount,
      totalPaise: total,
      campaignId,
      decision: JSON.stringify(decision),
      paymentRef,
      items: { create: { productId: product.id, unitPaise: product.pricePaise, role: "primary" } },
    },
  });
  await db.wallet.updateMany({
    data: {
      balancePaise: { decrement: total },
      spentThisMonthPaise: { increment: total },
    },
  });
  await db.product.update({ where: { id: product.id }, data: { stock: { decrement: 1 } } });
  if (campaignId) await recordCampaignConversion(campaignId, total);
  await audit("CHECKOUT", `Order ${shortId} auto-approved for ${product.sku}`, {
    orderId: shortId,
    amountPaise: total,
    decision: "AUTO_APPROVED",
    payload: { rules: decision.rules },
  });
  await audit("PAYMENT_CAPTURED", `Payment captured ${rupees(total)} (${paymentRef}) for ${shortId}`, {
    orderId: shortId,
    amountPaise: total,
    decision: "AUTO_APPROVED",
    payload: { paymentRef, gateway: "razorpay_test_mode" },
  });
  toolCalls.push({
    tool: "checkout_and_pay",
    status: "ok",
    summary: `Order ${shortId} paid — ${rupees(total)} captured (Razorpay test mode)`,
    data: { shortId, totalPaise: total, status: "PAID", paymentRef },
  });

  const offer = await recommendUpsells(product);
  if (offer) {
    toolCalls.push({
      tool: "upsell.recommend",
      status: "info",
      summary: `${offer.items.length} complementary picks ranked by margin × rating`,
      data: { offer: { ...offer, sourceOrderId: order.id } },
    });
    await audit("UPSELL_OFFERED", `Upsell offer generated for ${shortId}: ${offer.items.map((i) => i.product.sku).join(", ")}`, {
      orderId: shortId,
      payload: { items: offer.items.map((i) => ({ sku: i.product.sku, bundlePaise: i.bundlePaise })) },
    });
  }

  const offerText = offer
    ? `\n\nSince you picked the ${product.name.split("—")[0].trim()}, complete the kit with a **${offer.items.map((i) => i.product.name.split("—")[0].trim()).join("** or a **")}** — ${offer.items[0].reason} Bundle price **${rupees(offer.items[0].bundlePaise)}** (−10% for you, still the highest-margin pair for the merchant). Say **“add the ${offer.items[0].product.name.split("—")[0].trim().toLowerCase()}”** to grab it.`
    : "";
  return {
    text: `Done — **${product.name}** is yours. ✅\n\nOrder **${shortId}** was **auto-approved**: ${rupees(total)} captured via Razorpay test mode (\`${paymentRef}\`). Every rule passed server-side — check the policy card above for the line-by-line explanation.${offerText}`,
  };
}

function declineMessage(
  d: { declineCode?: string; reason: string },
  product: Product,
  shortId: string
): string {
  const next =
    d.declineCode === "VELOCITY_LIMIT"
      ? "I can retry automatically once the 10-minute velocity window cools down — say “retry” in a few minutes, or browse something else meanwhile."
      : d.declineCode === "BUDGET_EXCEEDED"
        ? "You can raise the monthly budget on the wallet panel, or I can suggest alternatives that fit the remaining runway."
        : "Top up the wallet, or I can find a lower-priced alternative in the same category.";
  return `I couldn't complete **${product.name}**. Order **${shortId}** was declined by the guardrails — **${d.declineCode}**.\n\n${d.reason}\n\nNo funds moved. ${next}`;
}

// ---------------------------------------------------------------- OTP

async function verifyOtp(code: string, toolCalls: ToolCall[]): Promise<{ text: string }> {
  const challenge = await db.otpChallenge.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { order: { include: { items: { include: { product: true } } } } },
  });

  if (!challenge || challenge.expiresAt < new Date()) {
    if (challenge) {
      await db.otpChallenge.update({ where: { id: challenge.id }, data: { status: "EXPIRED" } });
      await db.order.update({ where: { id: challenge.orderId }, data: { status: "DECLINED", declineCode: "OTP_EXPIRED" } });
      await db.wallet.updateMany({ data: { trustScore: { decrement: 4 } } });
      await audit("OTP_FAILED", `OTP expired for ${challenge.order.shortId} — order released`, {
        orderId: challenge.order.shortId,
        decision: "DECLINED",
        payload: { cause: "expired" },
      });
    }
    toolCalls.push({ tool: "verify_otp", status: "failed", summary: "No active OTP challenge" });
    return { text: "There's no active OTP right now — start a purchase above the auto-approve limit and I'll send one to your registered device." };
  }

  if (challenge.code !== code) {
    const attempts = challenge.attempts + 1;
    const expired = attempts >= 3;
    await db.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts, status: expired ? "EXPIRED" : "PENDING" },
    });
    if (expired) {
      await db.order.update({ where: { id: challenge.orderId }, data: { status: "DECLINED", declineCode: "OTP_EXPIRED" } });
      await db.wallet.updateMany({ data: { trustScore: { decrement: 4 } } });
      await audit("OTP_FAILED", `OTP failed 3× for ${challenge.order.shortId} — order released`, {
        orderId: challenge.order.shortId,
        decision: "DECLINED",
        payload: { cause: "max_attempts" },
      });
      toolCalls.push({ tool: "verify_otp", status: "failed", summary: "OTP incorrect 3 times — challenge expired" });
      return { text: "That OTP was incorrect three times — the hold is released and the order cancelled. No funds moved. Your trust score took a small hit; start the purchase again if you still want the item." };
    }
    toolCalls.push({ tool: "verify_otp", status: "failed", summary: `Incorrect OTP — attempt ${attempts}/3` });
    return { text: `That OTP doesn't match. Attempt **${attempts}/3** — after a third miss the hold is released automatically. Check the device simulator (bell icon) for the latest SMS.` };
  }

  // correct OTP → capture
  const order = challenge.order;
  const product = order.items[0].product;
  await db.otpChallenge.update({ where: { id: challenge.id }, data: { status: "VERIFIED" } });
  await db.wallet.updateMany({
    data: { balancePaise: { decrement: order.totalPaise }, spentThisMonthPaise: { increment: order.totalPaise }, trustScore: { increment: 8 } },
  });
  await db.product.update({ where: { id: product.id }, data: { stock: { decrement: 1 } } });
  const paymentRef = `rzp_test_${Math.random().toString(36).slice(2, 14)}`;
  await db.order.update({ where: { id: order.id }, data: { status: "PAID", paymentRef } });
  if (order.campaignId) await recordCampaignConversion(order.campaignId, order.totalPaise);
  await audit("OTP_VERIFIED", `OTP verified for ${order.shortId} — funds released`, {
    orderId: order.shortId,
    amountPaise: order.totalPaise,
    decision: "OTP_REQUIRED",
    payload: { trustDelta: "+8" },
  });
  await audit("PAYMENT_CAPTURED", `Payment captured ${rupees(order.totalPaise)} (${paymentRef}) for ${order.shortId}`, {
    orderId: order.shortId,
    amountPaise: order.totalPaise,
    decision: "AUTO_APPROVED",
    payload: { paymentRef, gateway: "razorpay_test_mode", via: "otp_release" },
  });
  toolCalls.push({ tool: "verify_otp", status: "ok", summary: `OTP verified — ${rupees(order.totalPaise)} released` });
  toolCalls.push({
    tool: "checkout_and_pay",
    status: "ok",
    summary: `Order ${order.shortId} paid — ${rupees(order.totalPaise)} captured (Razorpay test mode)`,
    data: { shortId: order.shortId, totalPaise: order.totalPaise, status: "PAID", paymentRef },
  });

  const offer = await recommendUpsells(product);
  if (offer) {
    toolCalls.push({
      tool: "upsell.recommend",
      status: "info",
      summary: `${offer.items.length} complementary picks ranked by margin × rating`,
      data: { offer: { ...offer, sourceOrderId: order.id } },
    });
    await audit("UPSELL_OFFERED", `Upsell offer generated for ${order.shortId}: ${offer.items.map((i) => i.product.sku).join(", ")}`, {
      orderId: order.shortId,
      payload: { items: offer.items.map((i) => ({ sku: i.product.sku, bundlePaise: i.bundlePaise })) },
    });
  }

  const w = await db.wallet.findFirst();
  const trustNote = w ? `Your trust score rose to **${Math.min(100, w.trustScore)}** — the auto-approve limit is now ${rupees(500000 + Math.min(Math.floor(Math.min(100, w.trustScore) / 25) * 50000, 200000))}.` : "";

  return {
    text: `Verified ✅ — **${rupees(order.totalPaise)}** released for order **${order.shortId}**. The **${product.name}** is confirmed (Razorpay test mode, \`${paymentRef}\`).\n\n${trustNote}${offer ? `\n\nOne more thing — complete the look: **${offer.items[0].product.name}** at bundle price **${rupees(offer.items[0].bundlePaise)}** (−10%). ${offer.items[0].reason} Say “add it” and I'll run it through the guardrails.` : ""}`,
  };
}

// ---------------------------------------------------------------- upsell accept/decline

async function acceptUpsell(
  offer: UpsellOffer,
  itemIndex: number,
  toolCalls: ToolCall[]
): Promise<{ text: string }> {
  const item = offer.items[itemIndex] ?? offer.items[0];
  const product = await db.product.findFirst({ where: { sku: item.product.sku } });
  if (!product || product.stock <= 0) {
    toolCalls.push({ tool: "upsell.recommend", status: "failed", summary: "Item out of stock" });
    return { text: "That pick just went out of stock — the offer is void, nothing was charged." };
  }
  const decision = await evaluatePolicy({ amountPaise: item.bundlePaise, product });
  const shortId = await nextShortId();
  if (decision.decision === "DECLINED") {
    await db.order.create({
      data: {
        shortId,
        status: "DECLINED",
        declineCode: decision.declineCode,
        subtotalPaise: item.originalPaise,
        discountPaise: item.originalPaise - item.bundlePaise,
        totalPaise: item.bundlePaise,
        decision: JSON.stringify(decision),
        items: { create: { productId: product.id, unitPaise: item.bundlePaise, role: "upsell" } },
      },
    });
    toolCalls.push({ tool: "checkout_and_pay", status: "declined", summary: `Upsell declined — ${decision.declineCode}` });
    await audit("DECLINED", `Upsell order ${shortId} declined (${decision.declineCode})`, {
      orderId: shortId, amountPaise: item.bundlePaise, decision: "DECLINED",
      payload: { declineCode: decision.declineCode },
    });
    return { text: `The add-on didn't clear the guardrails — **${decision.declineCode}**. ${decision.reason}` };
  }

  const paymentRef = `rzp_test_${Math.random().toString(36).slice(2, 14)}`;
  await db.order.create({
    data: {
      shortId,
      status: "PAID",
      subtotalPaise: item.originalPaise,
      discountPaise: item.originalPaise - item.bundlePaise,
      totalPaise: item.bundlePaise,
      decision: JSON.stringify(decision),
      paymentRef,
      items: { create: { productId: product.id, unitPaise: item.bundlePaise, role: "upsell" } },
    },
  });
  await db.wallet.updateMany({
    data: { balancePaise: { decrement: item.bundlePaise }, spentThisMonthPaise: { increment: item.bundlePaise } },
  });
  await db.product.update({ where: { id: product.id }, data: { stock: { decrement: 1 } } });
  await audit("UPSELL_ACCEPTED", `Upsell accepted: ${product.sku} for ${rupees(item.bundlePaise)} (${shortId})`, {
    orderId: shortId, amountPaise: item.bundlePaise, decision: "AUTO_APPROVED",
    payload: { bundleDiscountPct: 10, sourceSku: offer.sourceSku },
  });
  toolCalls.push({
    tool: "checkout_and_pay",
    status: "ok",
    summary: `Upsell ${shortId} paid — ${rupees(item.bundlePaise)} captured`,
    data: { shortId, totalPaise: item.bundlePaise, status: "PAID", paymentRef },
  });
  return {
    text: `Added ✅ — **${product.name}** at the bundle price **${rupees(item.bundlePaise)}** (saved ${rupees(item.originalPaise - item.bundlePaise)}). Order **${shortId}**, \`${paymentRef}\`. Attach rate is now visible on the merchant dashboard — that's revenue the agent grew, not just processed.`,
  };
}

// ---------------------------------------------------------------- main

export async function handleMessage(message: string): Promise<AgentResponse> {
  const text = message.trim();
  const t = text.toLowerCase();
  const toolCalls: ToolCall[] = [];
  let reply: { text: string } = { text: "" };

  const otpMatch = t.match(/\b(\d{6})\b/);
  const wallet = await db.wallet.findFirst();

  // ---- OTP submission
  if (otpMatch && /(otp|code|verify|password|passcode)/.test(t)) {
    reply = await verifyOtp(otpMatch[1], toolCalls);
  } else if (otpMatch && (await db.otpChallenge.findFirst({ where: { status: "PENDING", expiresAt: { gt: new Date() } } }))) {
    reply = await verifyOtp(otpMatch[1], toolCalls);
  }
  // ---- Upsell accept
  else if (/(add|accept|take|grab|yes)\b/.test(t) && /(it|strap|bracelet|kit|bundle|offer|deal|pod|care|case|add-?on)/.test(t) || /^(add it|yes|accept)$/.test(t)) {
    const offer = await pendingUpsellOffer();
    if (offer) {
      const idx = offer.items.findIndex((i) =>
        t.includes(i.product.name.split("—")[0].trim().toLowerCase().split(" ")[0])
      );
      reply = await acceptUpsell(offer, idx >= 0 ? idx : 0, toolCalls);
    } else {
      reply = { text: "There's no active bundle offer right now — buy something first and I'll surface the best add-ons." };
    }
  }
  // ---- Upsell decline
  else if (/(no thanks|decline|pass on|skip|not now)/.test(t)) {
    const offer = await pendingUpsellOffer();
    if (offer) {
      await audit("UPSELL_DECLINED", `Customer passed on upsell for ${offer.sourceSku}`, {
        payload: { offered: offer.items.map((i) => i.product.sku) },
      });
      reply = { text: "No problem — the offer stays open for 5 minutes in case you change your mind." };
    } else {
      reply = { text: "Alright — anything else I can help you find?" };
    }
  }
  // ---- Budget / balance
  else if (/(budget|how much.*(left|remain|spent)|runway|pacing)/.test(t)) {
    const w = wallet!;
    const wv = walletView(w);
    toolCalls.push({ tool: "budget.status", status: "info", summary: `Month-to-date ${rupees(wv.spentThisMonthPaise)} of ${rupees(wv.monthlyBudgetPaise)}`, data: { wallet: wv } });
    const advice =
      wv.budgetUsedPct > 75
        ? "You're pacing hot — I'd keep discretionary buys under " + rupees(Math.floor(wv.remainingBudgetPaise / 4)) + " for the rest of the month."
        : "Pacing is healthy — you have room for one more mid-range purchase without tripping budget rules.";
    reply = { text: `You've spent **${rupees(wv.spentThisMonthPaise)}** of the **${rupees(wv.monthlyBudgetPaise)}** monthly budget — **${rupees(wv.remainingBudgetPaise)}** of runway (${wv.budgetUsedPct}% used). Wallet balance: **${rupees(wv.balancePaise)}**.\n\n${advice}` };
  }
  // ---- Balance only
  else if (/^\/?balance$|wallet balance|how much (money|funds)/.test(t)) {
    const wv = walletView(wallet!);
    toolCalls.push({ tool: "budget.status", status: "info", summary: `Balance ${rupees(wv.balancePaise)}`, data: { wallet: wv } });
    reply = { text: `Wallet balance: **${rupees(wv.balancePaise)}**. Auto-approve limit: ${rupees(wv.effectiveLimitPaise)} (trust score ${wv.trustScore}). Purchases above that need an OTP.` };
  }
  // ---- Orders
  else if (/(my orders|order history|show orders|track order|what did i buy|recent purchases)/.test(t)) {
    const orders = await ordersLite();
    toolCalls.push({ tool: "orders.list", status: "info", summary: `${orders.length} recent orders`, data: { orders } });
    reply = {
      text: orders.length
        ? `Here's your recent activity:\n\n${orders.slice(0, 5).map((o) => `- **${o.shortId}** — ${o.firstItemName} · ${rupees(o.totalPaise)} · ${statusBadge(o.status)}`).join("\n")}`
        : "No orders yet — say “buy a premium watch” and watch the guardrails work.",
    };
  }
  // ---- Offers / campaigns
  else if (/(offer|campaign|deal|discount|sale|promo)/.test(t)) {
    const campaigns = await db.campaign.findMany({ where: { status: "ACTIVE" } });
    toolCalls.push({ tool: "campaigns.list", status: "info", summary: `${campaigns.length} active campaigns`, data: { campaigns } });
    reply = {
      text: campaigns.length
        ? `Live right now:\n\n${campaigns.map((c) => `- **${c.name}** — ${c.type === "FLAT_PERCENT" ? `${c.value}% off` : c.type} on ${c.scope.replace("category:", "").replace("sku:", "SKU ")} · ${c.conversions} conversions, ${rupees(c.incrementalPaise)} incremental revenue`).join("\n")}\n\nThe discount applies automatically at checkout — I'll show it as a line item before you pay.`
        : "No active campaigns. Merchants can launch one from the Campaigns tab — I'll apply it in-chat instantly.",
    };
  }
  // ---- Guardrail explanation
  else if (/(protect|guardrail|secur|safe|otp work|how.*(work|limit|threshold))/.test(t)) {
    const wv = walletView(wallet!);
    reply = {
      text: `**How your money is protected** — it's a policy stack, not a single threshold:\n\n1. **Wallet balance** — orders above your balance are declined before they start.\n2. **Budget pacing** — your ${rupees(wv.monthlyBudgetPaise)} monthly budget is a hard ceiling; projected overruns get declined with the math shown.\n3. **Velocity control** — more than 3 orders in 10 minutes gets blocked (card-testing style bursts fail gracefully).\n4. **Auto-approve limit** — only ${rupees(wv.effectiveLimitPaise)} auto-captures (base ${rupees(wv.baseLimitPaise)} + trust bonus ${rupees(wv.effectiveLimitPaise - wv.baseLimitPaise)}).\n5. **Category risk** — high-value watches/audio above ${rupees(800000)} need OTP even under the limit.\n6. **OTP gate** — everything else holds funds (never releases) until you enter the OTP sent to ${MASKED_DEVICE}.\n7. **Trust adaptation** — successful OTP verifications raise your limit (max +${rupees(200000)}); failures lower it.\n\nEvery decision is enforced server-side and logged rule-by-rule in the audit trail — nothing can be talked around from this chat.`,
    };
  }
  // ---- Help
  else if (/(help|what can you|capabilit|what do you do)/.test(t)) {
    reply = {
      text: `I'm your guardrailed shopping agent. Try:\n\n- **“Buy a premium watch for ₹10,000”** — OTP flow, full policy card\n- **“Buy a hoodie under ₹2,000”** — auto-approve path\n- **“add the strap”** — accept an upsell bundle\n- **“What's my budget?”** — pacing & advice\n- **“Any offers live?”** — campaign orchestration\n- **“How am I protected?”** — the full guardrail stack\n\nEvery money action is explainable, bounded, and audited.`,
    };
  }
  // ---- Buy flow
  else {
    const parsed = parseBuy(text);
    const results = parsed ? await searchProducts(parsed) : [];
    if (parsed && results.length > 0) {
      toolCalls.push({
        tool: "search_catalog",
        status: "ok",
        summary: `${results.length} matches for “${text.slice(0, 40)}”`,
        data: {
          results: results.map((p) => ({
            sku: p.sku, name: p.name, category: p.category, pricePaise: p.pricePaise, marginPct: p.marginPct, rating: p.rating, stock: p.stock,
          })),
        },
      });
      await audit("SEARCH", `Catalog search “${text.slice(0, 60)}” → ${results.length} results`, {
        payload: { skus: results.map((p) => p.sku) },
      });
      reply = await checkout(results[0], toolCalls);
    } else if (parsed) {
      toolCalls.push({ tool: "search_catalog", status: "failed", summary: "No catalog match" });
      reply = {
        text: `I couldn't find that in the catalog${parsed.maxPricePaise ? ` under ${rupees(parsed.maxPricePaise)}` : ""}. Browse the Catalog tab, or try: watches, hoodies, earbuds, speakers, straps, powerbanks.`,
      };
    } else {
      reply = {
        text: `I'm your guardrailed shopping agent — I can search the catalog, buy within policy, escalate OTPs to your device, and apply live campaigns. Try **“Buy a premium watch for ₹10,000”** or ask **“what can you do?”**`,
      };
    }
  }

  const w = await db.wallet.findFirst();
  return {
    assistantText: reply.text,
    toolCalls,
    wallet: walletView(w!),
    otpPending: await otpPending(),
    upsellOffer: await pendingUpsellOffer(),
    orders: await ordersLite(),
  };
}

function statusBadge(s: string): string {
  switch (s) {
    case "PAID": return "✅ paid";
    case "AWAITING_OTP": return "🔐 awaiting OTP";
    case "DECLINED": return "🚫 declined";
    default: return s;
  }
}
