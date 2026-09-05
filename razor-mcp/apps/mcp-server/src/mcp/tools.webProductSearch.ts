/**
 * MCP tool: web_product_search — REAL live-web products with REAL images.
 * Returns purchasable webIds (buy with sandbox funds via create_order).
 */
import { MCP_TOOLS, type WebProductSearchResponse } from '@razor-mcp/shared-types';
import { webProductSearch } from '../services/realtimeSearchService';
import type { McpToolDescriptor } from './toolRegistry';

export const webProductSearchTool: McpToolDescriptor = {
  name: MCP_TOOLS.WEB_PRODUCT_SEARCH,
  description:
    'Search the LIVE web for REAL products with REAL images and current prices (India). Each result has a webId usable in create_order / checkout_and_pay items as {"webId": "WEB-XXXXXXXX", "qty": 1} to buy it with the sandbox wallet.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Product query, e.g. "sony wh-1000xm5 headphones".' },
      maxPricePaise: { type: 'number', description: 'Only include products at or below this price (paise).' },
      maxResults: { type: 'number', description: 'Max products to return (default 6, max 10).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>): Promise<WebProductSearchResponse> => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      const e = new Error('INVALID_QUERY: query (non-empty string) is required.') as Error & { httpStatus?: number };
      e.httpStatus = 400;
      throw e;
    }
    const maxPricePaise = typeof args.maxPricePaise === 'number' && Number.isFinite(args.maxPricePaise) ? args.maxPricePaise : undefined;
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : undefined;
    return webProductSearch(query, { maxPricePaise, maxResults });
  },
};
