/**
 * MCP tool: create_order
 * Contract mirrors packages/shared-types/src/mcp.ts TOOL_SCHEMAS.
 *
 * Security invariants enforced here (and in orderService, never only here):
 *   - items validated (sku/qty bounds)
 *   - idempotencyKey REQUIRED (duplicate checkout prevention)
 *   - atomic all-or-nothing stock decrement with rollback on INSUFFICIENT_STOCK
 */
import { MCP_TOOLS, type CreateOrderResponse } from '@razor-mcp/shared-types';
import { createOrder } from '../services/orderService';
import { McpError } from './errors';
import type { CreateOrderArgs, McpToolDescriptor, ToolContext } from './toolRegistry';

export const createOrderTool: McpToolDescriptor = {
  name: MCP_TOOLS.CREATE_ORDER,
  description:
    'Create an order (reserves stock atomically). Does NOT pay. Payment is executed by the agent-service transaction engine (checkout_and_pay), which enforces the wallet guardrail.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Items to order — each has exactly one of sku (local catalog) or webId (live web product) plus qty.',
        items: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: 'Local catalog sku.' },
            webId: { type: 'string', description: 'Live web product id from web_product_search (WEB-...).' },
            qty: { type: 'number', description: 'Positive integer quantity.' },
          },
          required: ['qty'],
          additionalProperties: false,
        },
      },
      buyerAgentId: { type: 'string', description: 'Agent placing the order (pinned to the API key room for external keys).' },
      idempotencyKey: {
        type: 'string',
        description: 'Client-generated unique key (e.g. UUID). Same key = same order, never a duplicate.',
      },
    },
    required: ['items', 'buyerAgentId', 'idempotencyKey'],
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<CreateOrderResponse> => {
    const typed = args as unknown as CreateOrderArgs;
    if (!typed || typeof typed !== 'object') {
      throw new McpError(-32602, 'INVALID_PARAMS', { hint: 'arguments object required' });
    }
    if (typeof typed.buyerAgentId !== 'string' || typed.buyerAgentId.trim().length < 2) {
      throw new McpError(-32602, 'INVALID_PARAMS', { hint: 'buyerAgentId is required' });
    }
    return createOrder(typed.items, typed.buyerAgentId.trim(), typed.idempotencyKey, ctx);
  },
};
