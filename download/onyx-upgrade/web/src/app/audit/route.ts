import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  const events = await db.auditEvent.findMany({
    where: type && type !== "ALL" ? { type } : undefined,
    orderBy: { createdAt: "desc" },
    take: 80,
  });
  return NextResponse.json({
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      orderId: e.orderId,
      amountPaise: e.amountPaise,
      decision: e.decision,
      summary: e.summary,
      payload: safeParse(e.payload),
      at: e.createdAt.toISOString(),
    })),
  });
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}
