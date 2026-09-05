/**
 * Proxy: /api/agent/* -> agent-service (Flask).
 *
 * SEGMENT ROUTING (the spec pins the web proxy tree to /api/agent/*, so this one
 * proxy covers the agent-service surface):
 *   /api/agent/chat                -> AGENT_SERVICE_URL/api/agent/chat
 *   /api/agent/conversation/<id>   -> AGENT_SERVICE_URL/api/agent/conversation/<id>
 *   /api/agent/wallet/<agentId>    -> AGENT_SERVICE_URL/api/agent/wallet/<agentId>  (alias)
 *   /api/agent/transactions...     -> AGENT_SERVICE_URL/api/agent/transactions...  (read-only alias;
 *                                      money movement stays on the Flask API surface)
 *
 * The browser NEVER sees agent-service directly — no CORS, no direct origin,
 * and any future auth can be injected here server-side.
 */
import { NextRequest, NextResponse } from 'next/server';

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? 'http://localhost:5000';
const TIMEOUT_MS = 90_000; // LLM tool loops can legitimately take a while.

// Segments that are agent-service API namespaces (not part of the /api/agent prefix).
// Add 'auth' so `/api/agent/auth/*` maps to `/api/auth/*` on the agent-service.
const PASS_THROUGH_ROOTS = new Set(['wallet', 'transactions', 'health', 'auth']);

function buildTargetUrl(pathSegments: string[], search: string): string {
  const segs = (pathSegments ?? []).map((s) => encodeURIComponent(s));
  let path: string;
  if (segs.length > 0 && PASS_THROUGH_ROOTS.has(segs[0])) {
    path = `/api/${segs.join('/')}`;
  } else {
    path = `/api/agent/${segs.join('/')}`;
  }
  return `${AGENT_SERVICE_URL.replace(/\/$/, '')}${path}${search ?? ''}`;
}

async function forward(req: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  const url = buildTargetUrl(pathSegments, req.nextUrl.search);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // v2: pass the caller's login JWT through so agent-service can scope the room.
  const auth = req.headers.get('authorization');
  if (auth) headers['Authorization'] = auth;
  const idem = req.headers.get('idempotency-key');
  if (idem) headers['Idempotency-Key'] = idem;
  const init: RequestInit & { signal?: AbortSignal } = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }
  try {
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|abort/i.test(message);
    return NextResponse.json(
      { error: timedOut ? 'AGENT_SERVICE_TIMEOUT' : 'AGENT_SERVICE_UNREACHABLE', message },
      { status: timedOut ? 504 : 502 }
    );
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(req, path);
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const { path } = await ctx.params;
  return forward(req, path);
}
