import { NextRequest, NextResponse } from "next/server";
import { handleMessage } from "@/lib/agent/engine";

export async function POST(req: NextRequest) {
  try {
    const { message } = (await req.json()) as { message?: string };
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }
    const response = await handleMessage(message.slice(0, 500));
    return NextResponse.json(response);
  } catch (err) {
    console.error("chat error", err);
    return NextResponse.json({ error: "agent failure" }, { status: 500 });
  }
}
