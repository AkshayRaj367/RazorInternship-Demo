import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  const [products, campaigns] = await Promise.all([
    db.product.findMany({ where: { active: true }, orderBy: { category: "asc" } }),
    db.campaign.findMany({ where: { status: "ACTIVE" } }),
  ]);
  // agent-readable view: exactly what the agent reasons over
  return NextResponse.json({
    products: products.map((p) => ({
      sku: p.sku, name: p.name, category: p.category, description: p.description,
      pricePaise: p.pricePaise, marginPct: p.marginPct, stock: p.stock, rating: p.rating,
      tags: p.tags.split(","), compatibleWith: p.compatibleWith.split(",").filter(Boolean),
      campaign: campaigns.find(
        (c) => c.scope === "all" || c.scope === `category:${p.category}` || c.scope === `sku:${p.sku}`
      ) ?? null,
    })),
    campaigns,
  });
}
