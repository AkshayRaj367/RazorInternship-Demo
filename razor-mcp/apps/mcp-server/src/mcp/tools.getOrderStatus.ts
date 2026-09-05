/**
 * MCP tool: get_order_status
 * Contract mirrors packages/shared-types/src/mcp.ts TOOL_SCHEMAS.
 */
import { MCP_TOOLS, type OrderPublic } from '@razor-mcp/shared-types';
import { getOrderStatus } from '../services/orderService';
import type { GetOrderStatusArgs, McpToolDescriptor, ToolContext } from './toolRegistry';

export const getOrderStatusTool: McpToolDescriptor = {
  name: MCP_TOOLS.GET_ORDER_STATUS,
  description: 'Fetch the current status of an order by its human-readable orderNumber (e.g. "RZM-000123").',
  inputSchema: {
    type: 'object',
    properties: {
      orderNumber: { type: 'string' },
    },
    required: ['orderNumber'],
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>, ctx: ToolContext): Promise<OrderPublic> =>
    getOrderStatus(((args ?? {}) as unknown as GetOrderStatusArgs).orderNumber ?? '', ctx),
};
