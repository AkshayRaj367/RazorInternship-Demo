/**
 * Proxy: POST /api/mcp (bare) -> mcp-server POST /mcp.
 *
 * The [...path] catch-all handles segmented paths (REST fallback like
 * /api/mcp/catalog); the zero-segment JSON-RPC endpoint needs this handler.
 * Same security posture: X-API-Key injected server-side, never in the browser.
 */
import { NextRequest, NextResponse } from 'next/server';

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:4000';
const MCP_API_KEY = process.env.MCP_SERVER_INTERNAL_API_KEY ?? '';
const TIMEOUT_MS = 20_000;

async function forwardJsonRpc(req: NextRequest): Promise<Response> {
  if (!MCP_API_KEY) {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32004, message: 'UNAUTHORIZED: MCP_SERVER_INTERNAL_API_KEY is not configured on the web server' },
      },
      { status: 500 }
    );
  }
  try {
    const upstream = await fetch(`${MCP_SERVER_URL.replace(/\/$/, '')}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': MCP_API_KEY, // server-side secret — injected here, never exposed
      },
      body: await req.text(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
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

export async function POST(req: NextRequest): Promise<Response> {
  return forwardJsonRpc(req);
}

export async function GET(_req: NextRequest): Promise<Response> {
  return NextResponse.json(
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'METHOD_NOT_ALLOWED: POST a JSON-RPC 2.0 body to /api/mcp (use /api/mcp/catalog for the REST fallback)' } },
    { status: 405 }
  );
}
