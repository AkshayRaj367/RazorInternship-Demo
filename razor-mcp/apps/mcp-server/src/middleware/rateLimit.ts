/**
 * Per-API-key rate limiting (NOT per IP — one abusive key must not throttle others).
 * Keyed on req.apiKeyHash, which apiKeyAuth middleware sets. Default 60 req/min,
 * per-client override via api_clients.rateLimitPerMinute. Exceeding the limit
 * returns JSON-RPC error -32029 RATE_LIMITED with a Retry-After header.
 */
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { jsonRpcFailure, RATE_LIMITED_CODE } from '../mcp/errors';

export function perKeyRateLimit() {
  return rateLimit({
    windowMs: 60 * 1000,
    // Per-client configurable ceiling, read live from api_clients.
    max: (req: Request) => req.apiClient?.rateLimitPerMinute ?? 60,
    // Key on the API-key hash — falls back to IP only for unauthenticated paths
    // (the health endpoint is not behind this limiter anyway).
    keyGenerator: (req: Request) => req.apiKeyHash ?? `ip:${req.ip ?? 'unknown'}`,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      const resetMs = req.rateLimit?.resetTime instanceof Date ? req.rateLimit.resetTime.getTime() - Date.now() : 60_000;
      const retryAfterSec = Math.max(1, Math.ceil(resetMs / 1000));
      res.status(429).set('Retry-After', String(retryAfterSec)).json(
        jsonRpcFailure(
          (req.body as { id?: unknown } | undefined)?.id ?? null,
          RATE_LIMITED_CODE,
          'RATE_LIMITED',
          { retryAfterSeconds: retryAfterSec, limit: req.rateLimit?.limit ?? 60 }
        )
      );
    },
  });
}
