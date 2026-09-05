/**
 * Proxy: /api/mcp/* -> mcp-server (JSON-RPC 2.0 + REST fallback).
 *
 * The MCP X-API-Key is injected HERE, server-side only — it never reaches the
 * browser bundle (no NEXT_PUBLIC_ prefix, never serialized into a response).
 * Onyx never calls mcp-server from the browser either: its tool calls originate
 * in agent-service's llm_orchestrator with its own server-held key.
 *
 *   POST /api/mcp                  -> POST mcp-server /mcp          (JSON-RPC body passthrough)
 *   GET  /api/mcp/catalog[...]     -> GET  mcp-server /catalog[...]  (REST fallback)
 */
import { NextRequest, NextResponse } from 'next/server';

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:4000';
const MCP_API_KEY = process.env.MCP_SERVER_INTERNAL_API_KEY ?? '';
const TIMEOUT_MS = 20_000;

function buildTargetUrl(pathSegments: string[], search: string): string {
  const segs = (pathSegments ?? []).map((s) => encodeURIComponent(s));
  const path = segs.length === 0 ? '/mcp' : `/${segs.join('/')}`;
  return `${MCP_SERVER_URL.replace(/\/$/, '')}${path}${search ?? ''}`;
}

async function forward(req: NextRequest, pathSegments: string[]): Promise<Response> {
  if (!MCP_API_KEY) {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32004, message: 'UNAUTHORIZED: MCP_SERVER_INTERNAL_API_KEY is not configured on the web server' } },
      { status: 500 }
    );
  }
  const url = buildTargetUrl(pathSegments, req.nextUrl.search);
  const init: RequestInit & { signal?: AbortSignal } = {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': MCP_API_KEY, // server-side secret — injected here, never exposed
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }
  try {
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) headers.set('Retry-After', retryAfter);
    return new NextResponse(text, { status: upstream.status, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: `MCP_UNREACHABLE: ${message}` } },
      { status: 502 }
    );
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function POST(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return forward(req, path);
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { path } = await ctx.params;
  return forward(req, path);
}
