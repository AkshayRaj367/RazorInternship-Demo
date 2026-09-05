/**
 * MCP tool: get_item
 * Contract mirrors packages/shared-types/src/mcp.ts TOOL_SCHEMAS.
 */
import { MCP_TOOLS, type CatalogItemPublic } from '@razor-mcp/shared-types';
import { getItem } from '../services/catalogService';
import { McpError } from './errors';
import type { GetItemArgs, McpToolDescriptor } from './toolRegistry';

export const getItemTool: McpToolDescriptor = {
  name: MCP_TOOLS.GET_ITEM,
  description: 'Get full details for one catalog item by its exact sku.',
  inputSchema: {
    type: 'object',
    properties: {
      sku: { type: 'string', description: 'Exact sku, e.g. "APL-HOODIE-001".' },
    },
    required: ['sku'],
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>): Promise<CatalogItemPublic> => {
    const typed = args as unknown as GetItemArgs;
    if (typeof args?.sku !== 'string' || args.sku.trim().length === 0) {
      throw new McpError(-32602, 'INVALID_PARAMS', { hint: 'sku (string) is required' });
    }
    return getItem(args.sku.trim());
  },
};
