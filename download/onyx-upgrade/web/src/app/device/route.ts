import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Simulated registered device — where OTP SMS actually "arrive".
// In the real deployment this is your phone; in the demo it's this inbox.
export async function GET() {
  const challenges = await db.otpChallenge.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { order: { include: { items: { include: { product: true } } } } },
  });
  const messages = challenges.map((c) => ({
    id: c.id,
    code: c.code,
    status: c.status,
    expiresAt: c.expiresAt.toISOString(),
    at: c.createdAt.toISOString(),
    from: "RZRPAY",
    body:
      c.status === "PENDING"
        ? `${c.code} is your OTP to release ₹${(c.order.totalPaise / 100).toLocaleString("en-IN")} for ${c.order.items[0]?.product.name ?? "your order"} (${c.order.shortId}). Never share it.`
        : `${c.status === "VERIFIED" ? "Used" : "Expired"} OTP for ${c.order.shortId}.`,
  }));
  const unread = messages.filter((m) => m.status === "PENDING" && new Date(m.expiresAt) > new Date()).length;
  return NextResponse.json({ messages, unread });
}
