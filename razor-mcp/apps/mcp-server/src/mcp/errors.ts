/**
 * JSON-RPC 2.0 error plumbing shared by middleware, tools, and routes.
 */
import { MCP_ERROR_CODES, type JsonRpcFailure } from '@razor-mcp/shared-types';

export const UNAUTHORIZED_CODE = MCP_ERROR_CODES.UNAUTHORIZED;
export const RATE_LIMITED_CODE = MCP_ERROR_CODES.RATE_LIMITED;
export const INSUFFICIENT_STOCK_CODE = MCP_ERROR_CODES.INSUFFICIENT_STOCK;
export const MISSING_IDEMPOTENCY_KEY_CODE = MCP_ERROR_CODES.MISSING_IDEMPOTENCY_KEY;
export const INTERNAL_CODE = MCP_ERROR_CODES.INTERNAL;

/** The ApiClient.agentName reserved for the trusted agent-service internal key. */
export const INTERNAL_CALLER = 'agent-service-internal';

/** Application error carrying a JSON-RPC code. */
export class McpError extends Error {
  code: number;
  data?: unknown;
  httpStatus?: number;

  constructor(code: number, message: string, data?: unknown, httpStatus = 400) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

export class InsufficientStockError extends McpError {
  constructor(sku: string) {
    super(
      INSUFFICIENT_STOCK_CODE,
      'INSUFFICIENT_STOCK',
      { sku },
      409
    );
    this.name = 'InsufficientStockError';
  }
}

export function jsonRpcFailure(id: unknown, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : id === null ? null : null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function isHttpErrorLike(err: unknown): err is { status?: number; statusCode?: number; message: string } {
  return typeof err === 'object' && err !== null && 'message' in err;
}
