import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { walletView } from "@/lib/agent/policy";

export async function GET() {
  const wallet = await db.wallet.findFirst();
  if (!wallet) return NextResponse.json({ error: "no wallet" }, { status: 404 });
  return NextResponse.json({ wallet: walletView(wallet) });
}
