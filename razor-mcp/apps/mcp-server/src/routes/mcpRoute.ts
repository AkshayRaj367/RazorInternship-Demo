/**
 * POST /mcp — the JSON-RPC 2.0 MCP surface (behind X-API-Key auth + per-key rate limit).
 *
 * Supported requests:
 *   {"jsonrpc":"2.0","id":1,"method":"tools/list"}
 *   {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_catalog","arguments":{...}}}
 *   {"jsonrpc":"2.0","id":3,"method":"search_catalog","params":{...}}   (bare-name convenience)
 */
import type { NextFunction, Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';
import { callTool, isKnownTool, listTools, TOOL_REGISTRY, type ToolContext } from '../mcp/toolRegistry';
import { jsonRpcFailure, McpError, INTERNAL_CALLER } from '../mcp/errors';

/** Derive the caller context from the authenticated ApiClient (apiKeyAuth). */
function toolContext(req: Request): ToolContext {
  const agentName = req.apiClient?.agentName ?? null;
  return {
    callerRoom: typeof agentName === 'string' && agentName.length > 0 ? agentName : null,
    isInternal: agentName === INTERNAL_CALLER,
  };
}

export function buildMcpRouter(): Router {
  const router = createRouter();

  router.post('/mcp', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;
      const id = body?.id ?? null;

      if (body?.jsonrpc !== '2.0' || typeof body?.method !== 'string') {
        res.status(400).json(jsonRpcFailure(id, -32600, 'INVALID_REQUEST: jsonrpc must be "2.0" and method must be a string'));
        return;
      }

      const method: string = body.method;

      if (method === 'tools/list') {
        res.json({ jsonrpc: '2.0', id, result: { tools: listTools() } });
        return;
      }

      if (method === 'tools/call') {
        const params = (body.params ?? {}) as Record<string, unknown>;
        const toolName = params.name;
        if (!isKnownTool(toolName)) {
          res.status(404).json(jsonRpcFailure(id, -32601, `METHOD_NOT_FOUND: ${String(toolName)}`, { knownTools: Object.keys(TOOL_REGISTRY) }));
          return;
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await callTool(toolName, args, toolContext(req));
          res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: result }], result } });
        } catch (toolErr) {
          if (toolErr instanceof McpError) {
            const status = toolErr.httpStatus ?? 400;
            res.status(status).json(jsonRpcFailure(id, toolErr.code, toolErr.message, toolErr.data));
            return;
          }
          throw toolErr;
        }
        return;
      }

      if (isKnownTool(method)) {
        const args = (body.params ?? {}) as Record<string, unknown>;
        try {
          const result = await callTool(method, args, toolContext(req));
          res.json({ jsonrpc: '2.0', id, result });
        } catch (toolErr) {
          if (toolErr instanceof McpError) {
            res.status(toolErr.httpStatus ?? 400).json(jsonRpcFailure(id, toolErr.code, toolErr.message, toolErr.data));
            return;
          }
          throw toolErr;
        }
        return;
      }

      res.status(404).json(jsonRpcFailure(id, -32601, `METHOD_NOT_FOUND: ${method}`));
    } catch (err) {
      next(err);
    }
  });

  router.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json(jsonRpcFailure(null, -32600, 'METHOD_NOT_ALLOWED: use POST with a JSON-RPC 2.0 body'));
  });

  return router;
}
