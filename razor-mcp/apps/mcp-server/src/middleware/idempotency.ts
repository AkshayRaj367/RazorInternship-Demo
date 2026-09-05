/**
 * Reusable idempotency-key enforcement — THE single implementation used by every
 * non-naturally-idempotent write surface on this service (REST POST /orders and
 * the MCP create_order tool). Not hand-rolled per route.
 *
 *   requireIdempotencyKey  — Express middleware: reads `Idempotency-Key` header,
 *                            falls back to body.idempotencyKey, attaches to
 *                            req.idempotencyKey, 400 when missing.
 *   assertIdempotencyKey   — plain assertion used inside JSON-RPC tool arguments
 *                            (the key travels in params, not headers, there).
 */
import type { NextFunction, Request, Response } from 'express';
import { McpError, MISSING_IDEMPOTENCY_KEY_CODE } from '../mcp/errors';

const MAX_KEY_LEN = 200;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.trim().length >= 8 && key.length <= MAX_KEY_LEN;
}

export function assertIdempotencyKey(key: unknown): string {
  if (!isValidIdempotencyKey(key)) {
    throw new McpError(
      MISSING_IDEMPOTENCY_KEY_CODE,
      'MISSING_IDEMPOTENCY_KEY',
      { hint: 'Provide a client-generated idempotencyKey (min 8 chars, e.g. a UUID) so duplicate calls are safe to replay.' },
      400
    );
  }
  return (key as string).trim();
}

export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const fromHeader = req.header('idempotency-key');
  const fromBody = (req.body as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
  const key = fromHeader ?? fromBody;
  if (!isValidIdempotencyKey(key)) {
    res.status(400).json({
      error: 'MISSING_IDEMPOTENCY_KEY',
      hint: 'Send an Idempotency-Key header (or idempotencyKey in the JSON body), min 8 chars.',
    });
    return;
  }
  req.idempotencyKey = (key as string).trim();
  next();
}
