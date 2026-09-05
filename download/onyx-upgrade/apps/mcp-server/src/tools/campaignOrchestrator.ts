/**
 * Campaign Orchestrator — the merchant's growth lever.
 *
 * Campaigns are Mongo docs:
 *   { name, type: "FLAT_PERCENT", scope: "category:watches" | "sku:ACC-WATCH-001" | "all",
 *     value: 15, status: "ACTIVE" | "PAUSED" | "ENDED",
 *     budgetCapPaise, impressions, conversions, incrementalPaise, createdAt }
 *
 * Attribution flow:
 *   applyCampaign(product)  → records IMPRESSION, returns discount
 *   recordConversion(...)   → on payment capture of an attributed order
 *
 * The chat agent surfaces live campaigns on request and shows the discount
 * as an explicit checkout line item — nothing silent.
 */

export interface CampaignDoc {
  id: string;
  name: string;
  type: "FLAT_PERCENT" | "BUNDLE_DISCOUNT" | "FREE_SHIPPING";
  scope: string;
  value: number;
  status: "ACTIVE" | "PAUSED" | "ENDED";
  budgetCapPaise: number;
  impressions: number;
  conversions: number;
  incrementalPaise: number;
}

export interface ProductLike {
  sku: string;
  category: string;
  pricePaise: number;
}

export interface AppliedCampaign {
  campaign: CampaignDoc;
  discountPaise: number;
}

export function campaignMatches(c: CampaignDoc, p: ProductLike): boolean {
  if (c.scope === "all") return true;
  if (c.scope.startsWith("category:")) return c.scope.slice(9) === p.category;
  if (c.scope.startsWith("sku:")) return c.scope.slice(4) === p.sku;
  return false;
}

export function computeDiscount(c: CampaignDoc, p: ProductLike): number {
  if (c.type === "FLAT_PERCENT") return Math.round((p.pricePaise * c.value) / 100);
  return 0; // BUNDLE_DISCOUNT / FREE_SHIPPING apply at bundle/ship stage
}

/**
 * Pick the best active campaign for a product. ALSO record the impression —
 * attribution starts the moment the agent sees the campaign, not at payment.
 */
export function applyCampaign(
  product: ProductLike,
  activeCampaigns: CampaignDoc[],
  onImpression: (campaignId: string) => void
): AppliedCampaign | null {
  for (const c of activeCampaigns) {
    if (c.status !== "ACTIVE") continue;
    if (campaignMatches(c, product)) {
      onImpression(c.id);
      return { campaign: c, discountPaise: computeDiscount(c, product) };
    }
  }
  return null;
}

/** Call on payment capture for an order attributed to a campaign. */
export function recordConversion(
  c: CampaignDoc,
  totalPaise: number
): { conversions: number; incrementalPaise: number } {
  return { conversions: c.conversions + 1, incrementalPaise: c.incrementalPaise + totalPaise };
}

/** Validation for the create-campaign endpoint / MCP tool. */
export function validateCampaignInput(input: {
  name?: unknown; type?: unknown; scope?: unknown; value?: unknown;
}): { ok: true; value: { name: string; type: CampaignDoc["type"]; scope: string; value: number } } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const type = input.type as CampaignDoc["type"];
  const scope = typeof input.scope === "string" ? input.scope : "";
  const value = typeof input.value === "number" ? input.value : 0;

  if (!name) return { ok: false, error: "name required" };
  if (!["FLAT_PERCENT", "BUNDLE_DISCOUNT", "FREE_SHIPPING"].includes(type)) {
    return { ok: false, error: "type must be FLAT_PERCENT | BUNDLE_DISCOUNT | FREE_SHIPPING" };
  }
  if (type === "FLAT_PERCENT" && (value < 1 || value > 90)) {
    return { ok: false, error: "percent must be 1-90" };
  }
  const validScope =
    scope === "all" ||
    /^category:(watches|apparel|audio|accessories)$/.test(scope) ||
    /^sku:[A-Z0-9-]+$/.test(scope);
  if (!validScope) return { ok: false, error: "scope must be all | category:<x> | sku:<X>" };

  return { ok: true, value: { name, type, scope, value } };
}

/* ------------------------------------------------------------------ */
/* MCP tool registrations                                            */
/* ------------------------------------------------------------------ */
export const listCampaignsToolSchema = {
  name: "list_campaigns",
  description: "List active merchant campaigns (offers). Surface these when the customer asks about deals; the discount applies automatically at checkout as a visible line item.",
  inputSchema: { type: "object" as const, properties: {} },
};

export const createCampaignToolSchema = {
  name: "create_campaign",
  description:
    "Launch a growth campaign. type=FLAT_PERCENT with value=percent off; scope picks what it applies to. Live instantly — the agent starts applying it in the next checkout. Audited as CAMPAIGN_CREATED.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      type: { type: "string", enum: ["FLAT_PERCENT", "BUNDLE_DISCOUNT", "FREE_SHIPPING"] },
      scope: { type: "string", description: "all | category:watches | sku:ACC-WATCH-001" },
      value: { type: "number" },
      budget_cap_paise: { type: "number" },
    },
    required: ["name", "type", "scope"],
  },
};
