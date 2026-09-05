import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rupees } from "@/lib/agent/policy";

export async function GET() {
  const campaigns = await db.campaign.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json({ campaigns });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { name, type, scope, value, budgetCapRupees } = body as {
    name?: string; type?: string; scope?: string; value?: number; budgetCapRupees?: number;
  };

  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!["FLAT_PERCENT", "BUNDLE_DISCOUNT", "FREE_SHIPPING"].includes(type ?? "")) {
    return NextResponse.json({ error: "type must be FLAT_PERCENT | BUNDLE_DISCOUNT | FREE_SHIPPING" }, { status: 400 });
  }
  if (type === "FLAT_PERCENT" && (!value || value < 1 || value > 90)) {
    return NextResponse.json({ error: "percent must be 1-90" }, { status: 400 });
  }
  const validScope =
    scope === "all" ||
    (scope?.startsWith("category:") && ["watches", "apparel", "audio", "accessories"].includes(scope.slice(9))) ||
    scope?.startsWith("sku:");
  if (!validScope) return NextResponse.json({ error: "scope must be all | category:<x> | sku:<X>" }, { status: 400 });

  const campaign = await db.campaign.create({
    data: {
      name: name.trim().slice(0, 60),
      type: type!,
      scope: scope!,
      value: Math.round(value ?? 0),
      budgetCapPaise: Math.round((budgetCapRupees ?? 5000) * 100),
      status: "ACTIVE",
    },
  });

  await db.auditEvent.create({
    data: {
      type: "CAMPAIGN_CREATED",
      summary: `Campaign “${campaign.name}” launched (${campaign.type} ${campaign.value} on ${campaign.scope})`,
      payload: JSON.stringify({ cap: rupees(campaign.budgetCapPaise) }),
    },
  });

  return NextResponse.json({ campaign });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { id, status } = (body ?? {}) as { id?: string; status?: string };
  if (!id || !["ACTIVE", "PAUSED", "ENDED"].includes(status ?? "")) {
    return NextResponse.json({ error: "id + status (ACTIVE|PAUSED|ENDED) required" }, { status: 400 });
  }
  const campaign = await db.campaign.update({ where: { id }, data: { status: status! } }).catch(() => null);
  if (!campaign) return NextResponse.json({ error: "not found" }, { status: 404 });
  await db.auditEvent.create({
    data: {
      type: "CAMPAIGN_UPDATED",
      summary: `Campaign “${campaign.name}” → ${campaign.status}`,
      payload: "{}",
    },
  });
  return NextResponse.json({ campaign });
}
