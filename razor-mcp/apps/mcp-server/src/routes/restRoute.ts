/**
 * REST fallback — GET /catalog, GET /catalog/:sku, POST /orders.
 * Calls the SAME service functions as the MCP tools (zero duplicated business
 * logic). POST /orders goes through the reusable requireIdempotencyKey middleware.
 */
import type { NextFunction, Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { getItem, searchCatalog } from '../services/catalogService';
import { createOrder, getOrderStatus } from '../services/orderService';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { McpError } from '../mcp/errors';
import { INTERNAL_CALLER } from '../mcp/errors';
import type { ToolContext } from '../mcp/toolRegistry';

/** Derive the caller context from the authenticated ApiClient (apiKeyAuth). */
function toolContext(req: Request): ToolContext {
  const agentName = req.apiClient?.agentName ?? null;
  return {
    callerRoom: typeof agentName === 'string' && agentName.length > 0 ? agentName : null,
    isInternal: agentName === INTERNAL_CALLER,
  };
}

export function buildRestRouter(): Router {
  const router = createRouter();

  router.get('/catalog', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const maxPricePaise = req.query.maxPricePaise;
      const result = await searchCatalog({
        query: typeof req.query.query === 'string' ? req.query.query : undefined,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        maxPricePaise:
          typeof maxPricePaise === 'string' && /^\d+$/.test(maxPricePaise)
            ? parseInt(maxPricePaise, 10)
            : undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/catalog/:sku', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getItem(req.params.sku));
    } catch (err) {
      next(err);
    }
  });

  router.get('/orders/:orderNumber', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getOrderStatus(req.params.orderNumber, toolContext(req)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/orders', requireIdempotencyKey, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { items?: unknown; buyerAgentId?: unknown; idempotencyKey?: string };
      const order = await createOrder(body.items, String(body.buyerAgentId ?? ''), req.idempotencyKey, toolContext(req));
      res.status(order.duplicate ? 200 : 201).json(order);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Map service errors to clean REST responses (McpError carries code/status). */
export function restErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof McpError) {
    res.status(err.httpStatus ?? 400).json({ error: err.message, code: err.code, ...(err.data ? { data: err.data } : {}) });
    return;
  }
  const e = err as { status?: number; message?: string };
  if (e?.status === 404 || /_NOT_FOUND/.test(String(e?.message ?? ''))) {
    res.status(404).json({ error: e?.message ?? 'NOT_FOUND' });
    return;
  }
  console.error('[mcp-server] unhandled REST error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
}
