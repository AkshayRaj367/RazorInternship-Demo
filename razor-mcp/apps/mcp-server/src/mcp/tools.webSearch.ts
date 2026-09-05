/**
 * MCP tool: web_search — keyless live web search (Bing/DDG/Google chain).
 */
import { MCP_TOOLS, type WebSearchResponse } from '@razor-mcp/shared-types';
import { webSearch } from '../services/realtimeSearchService';
import type { McpToolDescriptor } from './toolRegistry';

export const webSearchTool: McpToolDescriptor = {
  name: MCP_TOOLS.WEB_SEARCH,
  description:
    'Search the LIVE web (real-time results, not the local catalog). Use for current events, product research, comparisons, prices in India, or anything the local catalog cannot answer. Returns real titles, URLs and snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The web search query.' },
      maxResults: { type: 'number', description: 'Max results to return (default 5, max 10).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args: Record<string, unknown>): Promise<WebSearchResponse> => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      const e = new Error('INVALID_QUERY: query (non-empty string) is required.') as Error & { httpStatus?: number };
      e.httpStatus = 400;
      throw e;
    }
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 5;
    return webSearch(query, maxResults);
  },
};
