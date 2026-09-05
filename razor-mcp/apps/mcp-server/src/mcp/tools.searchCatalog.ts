/**
 * MCP tool: search_catalog
 * Contract mirrors packages/shared-types/src/mcp.ts TOOL_SCHEMAS.
 */
import { MCP_TOOLS, type CatalogListResponse } from '@razor-mcp/shared-types';
import { searchCatalog } from '../services/catalogService';
import type { McpToolDescriptor, SearchCatalogArgs } from './toolRegistry';

export const searchCatalogTool: McpToolDescriptor = {
  name: MCP_TOOLS.SEARCH_CATALOG,
  description:
    'Search the product catalog. Optionally filter by free-text query, category, and a maximum price (in paise; Rs 1 = 100 paise).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search over name and description.' },
      category: { type: 'string', description: 'Exact category filter, e.g. "apparel", "electronics".' },
      maxPricePaise: { type: 'number', description: 'Only items at or below this price in paise.' },
    },
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>): Promise<CatalogListResponse> =>
    searchCatalog(args as SearchCatalogArgs),
};
