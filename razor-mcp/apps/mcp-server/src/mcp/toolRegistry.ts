/**
 * MCP tool registry — the JSON-RPC 2.0 dispatch table for POST /mcp.
 *
 * `tools/list`  -> descriptors (name / description / inputSchema)
 * `tools/call`  -> { name, arguments } dispatch to the handler
 * A method string equal to a bare tool name (e.g. "search_catalog") is also
 * accepted for convenience and routed to the same handler.
 *
 * The REST fallback (routes/restRoute.ts) calls these SAME service functions —
 * no duplicated business logic anywhere.
 *
 * CALLER CONTEXT (room isolation): `callTool` accepts an optional ToolContext
 * describing the authenticated API client. External agent keys are bound to
 * a room (agentName = "user:<uid>"); create_order/get_order_status use the
 * context to force/verify that binding so one agent can never create orders
 * for, or read the orders of, another room. The internal agent-service key
 * is trusted to pass buyerAgentId itself (it derives it from a verified JWT).
 */
import { MCP_TOOLS } from '@razor-mcp/shared-types';
import type { CatalogItemPublic, CatalogListResponse, CreateOrderResponse, OrderPublic, SearchCatalogArgs, GetItemArgs, CreateOrderArgs, GetOrderStatusArgs } from '@razor-mcp/shared-types';
import { McpError } from './errors';
import { searchCatalogTool } from './tools.searchCatalog';
import { getItemTool } from './tools.getItem';
import { createOrderTool } from './tools.createOrder';
import { getOrderStatusTool } from './tools.getOrderStatus';
import { webSearchTool } from './tools.webSearch';
import { webProductSearchTool } from './tools.webProductSearch';

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

/** Authenticated caller info (from apiKeyAuth). */
export interface ToolContext {
  /** The ApiClient.agentName — "user:<uid>" for external agent keys, "agent-service-internal" for the trusted internal key. */
  callerRoom: string | null;
  /** True when the caller is the trusted internal key (agent-service). */
  isInternal: boolean;
}

export type { SearchCatalogArgs, GetItemArgs, CreateOrderArgs, GetOrderStatusArgs, CatalogItemPublic, CatalogListResponse, CreateOrderResponse, OrderPublic };

export const TOOL_REGISTRY: Record<string, McpToolDescriptor> = {
  [searchCatalogTool.name]: searchCatalogTool,
  [getItemTool.name]: getItemTool,
  [createOrderTool.name]: createOrderTool,
  [getOrderStatusTool.name]: getOrderStatusTool,
  [webSearchTool.name]: webSearchTool,
  [webProductSearchTool.name]: webProductSearchTool,
};

export function listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function isKnownTool(name: unknown): name is string {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name);
}

export async function callTool(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: ToolContext = { callerRoom: null, isInternal: false }
): Promise<unknown> {
  if (!isKnownTool(name)) {
    throw new McpError(-32601, `METHOD_NOT_FOUND: ${name}`, { knownTools: Object.keys(TOOL_REGISTRY) }, 404);
  }
  return TOOL_REGISTRY[name].handler(args ?? {}, ctx);
}

export { MCP_TOOLS };
