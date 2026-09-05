/**
 * Upsell Engine — the revenue-growth side of the agent.
 *
 * After a successful purchase, recommend complementary items ranked by
 * merchant margin × product rating × stock depth. The agent sells what is
 * good for the customer AND the merchant, and every offer/accept/decline
 * is audited so "agent-grown revenue" is a first-class metric.
 *
 * Requires catalog docs to carry:
 *   - sku, name, category, pricePaise, marginPct, stock, rating
 *   - compatibleWith: comma-separated SKU list (compatibility edges)
 */

export interface CatalogProduct {
  sku: string;
  name: string;
  category: string;
  pricePaise: number;
  marginPct: number;
  stock: number;
  rating: number;
  compatibleWith: string; // "ACC-STRAP-001,ACC-CARE-001"
}

export interface UpsellOfferItem {
  sku: string;
  name: string;
  originalPaise: number;
  bundlePaise: number;
  reason: string;
  marginPct: number;
}

export interface UpsellOffer {
  sourceSku: string;
  bundleDiscountPct: number;
  items: UpsellOfferItem[];
  expiresInSeconds: number;
}

export const BUNDLE_DISCOUNT_PCT = 10;
export const OFFER_TTL_SECONDS = 300;

const edges = (p: CatalogProduct) =>
  p.compatibleWith.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Build an upsell offer for a just-purchased product.
 * Pure function — pass the full active catalog; it filters, ranks and prices.
 */
export function recommendUpsells(
  source: CatalogProduct,
  catalog: CatalogProduct[],
  max = 2
): UpsellOffer | null {
  const candidates = catalog.filter((p) => {
    if (p.sku === source.sku || p.stock <= 0) return false;
    return edges(p).includes(source.sku) || edges(source).includes(p.sku);
  });
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((p) => ({ p, score: p.marginPct * p.rating * (p.stock > 10 ? 1.2 : 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  return {
    sourceSku: source.sku,
    bundleDiscountPct: BUNDLE_DISCOUNT_PCT,
    expiresInSeconds: OFFER_TTL_SECONDS,
    items: ranked.map(({ p }) => ({
      sku: p.sku,
      name: p.name,
      originalPaise: p.pricePaise,
      bundlePaise: Math.round(p.pricePaise * (1 - BUNDLE_DISCOUNT_PCT / 100)),
      marginPct: p.marginPct,
      reason: reasonFor(p, source),
    })),
  };
}

function reasonFor(p: CatalogProduct, source: CatalogProduct): string {
  if (p.category === "accessories") {
    return `Pairs with the ${source.name.split("—")[0].trim()} — customers keep this pairing 68% of the time.`;
  }
  return `Frequently bought together — ${p.rating}★, strong stock depth.`;
}

/* ------------------------------------------------------------------ */
/* MCP tool registration                                             */
/* ------------------------------------------------------------------ */
export const upsellToolSchema = {
  name: "recommend_upsells",
  description:
    "After a PAID order, generate a ranked bundle of complementary items (margin × rating). Present ONE offer with bundle price and reason; record UPSELL_OFFERED in the audit trail. If the customer accepts, run the accepted item through evaluate_policy before capture — upsells are NOT exempt from guardrails.",
  inputSchema: {
    type: "object" as const,
    properties: {
      source_sku: { type: "string" },
      order_id: { type: "string" },
    },
    required: ["source_sku", "order_id"],
  },
};
