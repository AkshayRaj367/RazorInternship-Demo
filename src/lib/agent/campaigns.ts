import { db } from "@/lib/db";
import type { Campaign, Product } from "@prisma/client";

export interface AppliedCampaign {
  campaign: Campaign;
  discountPaise: number;
}

/**
 * Campaign orchestrator: find the active campaign that applies to a product,
 * compute the discount and record the impression (attribution starts here).
 */
export async function applyCampaign(product: Product): Promise<AppliedCampaign | null> {
  const campaigns = await db.campaign.findMany({ where: { status: "ACTIVE" } });

  for (const c of campaigns) {
    if (c.scope.startsWith("category:") && c.scope.slice(9) === product.category) {
      const discountPaise =
        c.type === "FLAT_PERCENT" ? Math.round((product.pricePaise * c.value) / 100) : 0;
      await db.campaign.update({
        where: { id: c.id },
        data: { impressions: { increment: 1 } },
      });
      return { campaign: { ...c, impressions: c.impressions + 1 }, discountPaise };
    }
    if (c.scope.startsWith("sku:") && c.scope.slice(4) === product.sku) {
      const discountPaise =
        c.type === "FLAT_PERCENT" ? Math.round((product.pricePaise * c.value) / 100) : 0;
      await db.campaign.update({
        where: { id: c.id },
        data: { impressions: { increment: 1 } },
      });
      return { campaign: { ...c, impressions: c.impressions + 1 }, discountPaise };
    }
    if (c.scope === "all") {
      const discountPaise =
        c.type === "FLAT_PERCENT" ? Math.round((product.pricePaise * c.value) / 100) : 0;
      await db.campaign.update({
        where: { id: c.id },
        data: { impressions: { increment: 1 } },
      });
      return { campaign: { ...c, impressions: c.impressions + 1 }, discountPaise };
    }
  }
  return null;
}

export async function recordCampaignConversion(campaignId: string, totalPaise: number) {
  await db.campaign.update({
    where: { id: campaignId },
    data: { conversions: { increment: 1 }, incrementalPaise: { increment: totalPaise } },
  });
}
