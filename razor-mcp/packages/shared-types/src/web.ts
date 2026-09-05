/**
 * REAL-TIME web search contracts — keyless multi-engine scraping (Bing →
 * DuckDuckGo → Google HTML fallback chain) + Bing image resolution.
 *
 * The mcp-server implements `web_search` / `web_product_search` over this
 * contract; llm_orchestrator.py mirrors the TOOL_SCHEMAS (see mcp.ts).
 *
 * Products found here are REAL internet listings with REAL image URLs. They
 * are purchasable through the sandbox/fake-funds wallet using their `webId`.
 */

/** One organic web result (general knowledge / research tool). */
export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebSearchResponse {
  results: WebResult[];
  count: number;
  query: string;
  engine: string;
  cached: boolean;
}

/** One REAL product listing scraped from the live web, with a real image. */
export interface WebProduct {
  /** Stable purchase reference (WEB-XXXXXXXX) — pass to create_order/checkout_and_pay. */
  webId: string;
  name: string;
  /** Extracted price in paise when confidently parsed, else null. */
  pricePaise: number | null;
  /** Raw price text as seen on the web (e.g. "₹26,990"). */
  priceText: string | null;
  source: string;
  /** Product/landing page URL. */
  url: string;
  /** Real image URL (direct media link). */
  image: string;
  snippet: string;
}

export interface WebProductSearchResponse {
  products: WebProduct[];
  count: number;
  query: string;
  engine: string;
  cached: boolean;
  note?: string;
}

/** web_search arguments. */
export interface WebSearchArgs {
  query: string;
  maxResults?: number;
}

/** web_product_search arguments. */
export interface WebProductSearchArgs {
  query: string;
  maxPricePaise?: number;
  maxResults?: number;
}

export const MCP_TOOLS_V2 = {
  WEB_SEARCH: 'web_search',
  WEB_PRODUCT_SEARCH: 'web_product_search',
} as const;

export type WebMcpToolName = (typeof MCP_TOOLS_V2)[keyof typeof MCP_TOOLS_V2];
