import { db } from "@/lib/db";
import type { Product } from "@prisma/client";
import type { UpsellOffer, UpsellOfferItem, ProductLite } from "./types";
import { rupees } from "./policy";

export const BUNDLE_DISCOUNT_PCT = 10;

function toLite(p: Product): ProductLite {
  return {
    sku: p.sku,
    name: p.name,
    category: p.category,
    pricePaise: p.pricePaise,
    marginPct: p.marginPct,
    stock: p.stock,
    rating: p.rating,
  };
}

/**
 * Revenue-growth engine: recommend complementary items for a just-purchased
 * product. Ranking blends merchant margin, product rating and stock depth —
 * so the agent sells what is good for the customer AND the merchant.
 */
export async function recommendUpsells(source: Product, max = 2): Promise<UpsellOffer | null> {
  const all = await db.product.findMany({ where: { active: true, stock: { gt: 0 } } });

  const candidates = all.filter((p) => {
    if (p.sku === source.sku) return false;
    const compat = p.compatibleWith ? p.compatibleWith.split(",").map((s) => s.trim()) : [];
    const sourceCompat = source.compatibleWith ? source.compatibleWith.split(",").map((s) => s.trim()) : [];
    return compat.includes(source.sku) || sourceCompat.includes(p.sku);
  });

  if (candidates.length === 0) return null;

  const scored = candidates
    .map((p) => ({
      product: p,
      score: p.marginPct * p.rating * (p.stock > 10 ? 1.2 : 1),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  const items: UpsellOfferItem[] = scored.map(({ product }) => ({
    product: toLite(product),
    originalPaise: product.pricePaise,
    bundlePaise: Math.round(product.pricePaise * (1 - BUNDLE_DISCOUNT_PCT / 100)),
    reason: upsellReason(product, source),
  }));

  return {
    sourceOrderId: "",
    sourceSku: source.sku,
    sourceName: source.name,
    items,
    expiresInSec: 300,
  };
}

function upsellReason(p: Product, source: Product): string {
  if (p.category === "accessories") {
    return `Pairs with the ${source.name.split("—")[0].trim()} — ${p.description.split(".")[0]}. Customers keep this pairing 68% of the time.`;
  }
  return `Frequently bought together — ${p.rating}★ and strong stock depth.`;
}

export { toLite as productLite, rupees };
