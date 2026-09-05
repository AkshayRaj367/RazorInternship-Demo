/**
 * X-API-Key authentication middleware.
 * The raw key NEVER touches the database — only sha256(MCP_API_KEY_SALT:key) is
 * looked up in api_clients. Order matters: this runs BEFORE rate limiting so the
 * limiter can key on the API key, not the IP.
 */
import type { NextFunction, Request, Response } from 'express';
import { ApiClient, hashApiKey, type ApiClientDoc } from '../models/apiClient';
import { jsonRpcFailure, UNAUTHORIZED_CODE } from '../mcp/errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiClient?: ApiClientDoc;
      apiKeyHash?: string;
      idempotencyKey?: string;
      /** Populated by express-rate-limit (v7/v8) — kept optional for unauthenticated paths. */
      rateLimit?: { limit?: number; current?: number; remaining?: number; resetTime?: Date };
    }
  }
}

export function apiKeyAuth(salt: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawKey = req.header('x-api-key');
      if (!rawKey || typeof rawKey !== 'string' || rawKey.length < 8) {
        res.status(401).json(
          jsonRpcFailure(req.body?.id ?? null, UNAUTHORIZED_CODE, 'UNAUTHORIZED: missing or malformed X-API-Key header')
        );
        return;
      }
      const apiKeyHash = hashApiKey(rawKey, salt);
      const apiClient = await ApiClient.findOne({ apiKeyHash }).lean<ApiClientDoc>();
      if (!apiClient) {
        res.status(401).json(
          jsonRpcFailure(req.body?.id ?? null, UNAUTHORIZED_CODE, 'UNAUTHORIZED: API key not recognized')
        );
        return;
      }
      req.apiClient = apiClient;
      req.apiKeyHash = apiKeyHash;
      next();
    } catch (err) {
      next(err);
    }
  };
}
