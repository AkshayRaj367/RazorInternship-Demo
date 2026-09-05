/**
 * Proxy: GET /api/audit/[sessionId] -> agent-service GET /api/audit/[sessionId].
 *
 * HTTP hydration fallback for the timeline. The PRIMARY path is the Socket.IO
 * backlog replay (audit:backlog on room join) — this exists for environments
 * where WebSockets are blocked, and for first-paint reconciliation.
 */
import { NextRequest, NextResponse } from 'next/server';

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? 'http://localhost:5000';

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { sessionId } = await ctx.params;
  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(sessionId ?? '')) {
    return NextResponse.json({ error: 'INVALID_SESSION_ID' }, { status: 400 });
  }
  // v2: forward the login JWT so agent-service can filter the timeline by room.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = req.headers.get('authorization');
  if (auth) headers['Authorization'] = auth;
  try {
    const upstream = await fetch(
      `${AGENT_SERVICE_URL.replace(/\/$/, '')}/api/audit/${encodeURIComponent(sessionId)}`,
      {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      }
    );
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'AGENT_SERVICE_UNREACHABLE', message }, { status: 502 });
  }
}
