/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 contracts + the LLM function-schema
 * contract.
 *
 * This file is the SINGLE contract shared three ways:
 *   1. apps/mcp-server/src/mcp/toolRegistry.ts implements the four tools over it.
 *   2. apps/web/src/app/api/mcp/[...path]/route.ts proxies JSON-RPC bodies shaped by it.
 *   3. apps/agent-service/services/llm_orchestrator.py mirrors TOOL_SCHEMAS verbatim
 *      (Python dict literals) so Onyx's tool-calling loop, the MCP server, and the
 *      frontend share ONE contract. If you edit a schema here, edit the mirror there.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export const JSON_RPC_VERSION = '2.0';

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number | null;
  result: T;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | number | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;

// ---------------------------------------------------------------------------
// Application error codes (JSON-RPC server-error space, -32000..-32099)
// ---------------------------------------------------------------------------

export const MCP_ERROR_CODES = {
  /** Generic application error. */
  INTERNAL: -32000,
  /** Stock was insufficient at the moment of the atomic check (data: { sku }). */
  INSUFFICIENT_STOCK: -32001,
  /** Missing/invalid idempotency key on a non-naturally-idempotent write. */
  MISSING_IDEMPOTENCY_KEY: -32002,
  /** Wallet/guardrail enforcement failures relayed from agent-service. */
  GUARDRAIL_VIOLATION: -32003,
  /** X-API-Key missing or not found in api_clients. */
  UNAUTHORIZED: -32004,
  /** Per-API-key rate limit exceeded (accompanied by a Retry-After header). */
  RATE_LIMITED: -32029,
} as const;

// ---------------------------------------------------------------------------
// Tool contracts
// ---------------------------------------------------------------------------

export const MCP_TOOLS = {
  SEARCH_CATALOG: 'search_catalog',
  GET_ITEM: 'get_item',
  CREATE_ORDER: 'create_order',
  GET_ORDER_STATUS: 'get_order_status',
  WEB_SEARCH: 'web_search',
  WEB_PRODUCT_SEARCH: 'web_product_search',
} as const;

export type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

/** search_catalog arguments. */
export interface SearchCatalogArgs {
  query?: string;
  category?: string;
  maxPricePaise?: number;
}

/** get_item arguments. */
export interface GetItemArgs {
  sku: string;
}

/** create_order arguments. Items reference local catalog skus OR live web products by webId. */
export interface CreateOrderArgs {
  items: Array<{ sku?: string; webId?: string; qty: number }>;
  buyerAgentId: string;
  idempotencyKey: string;
}

/** get_order_status arguments. */
export interface GetOrderStatusArgs {
  orderNumber: string;
}

/** tools/list descriptor entry. */
export interface McpToolDescriptor {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

// ---------------------------------------------------------------------------
// LLM function-schema contract (OpenAI-compatible `tools=[...]` shape)
// ---------------------------------------------------------------------------

/**
 * The exact function specs passed to the chat-completions `tools` parameter by
 * llm_orchestrator.py. `checkout_and_pay` is implemented ONLY inside agent-service
 * (it routes through transaction_service.execute_transaction — the guardrail path);
 * it is deliberately NOT exposed on the mcp-server.
 */
export const TOOL_SCHEMAS: Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> = [
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description:
        'Search the product catalog. Optionally filter by free-text query, category, and a maximum price (in paise; Rs 1 = 100 paise). Returns matching items with sku, name, price and stock.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search over name and description.' },
          category: { type: 'string', description: 'Exact category filter, e.g. "apparel", "electronics".' },
          maxPricePaise: { type: 'number', description: 'Only items at or below this price in paise.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_item',
      description: 'Get full details for one catalog item by its exact sku.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Exact sku, e.g. "APL-HOODIE-001".' },
        },
        required: ['sku'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'checkout_and_pay',
      description:
        'Execute payment for a list of items: creates the order and pays from the sandbox wallet. Items may be local catalog items {"sku","qty"} OR real web products {"webId","qty"} from web_product_search. Amounts at or under the delegated limit execute autonomously; amounts above it return awaiting_otp and require OTP verification (humans: emailed; agents: inline in this response) — report that status honestly. Requires an idempotencyKey.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Items to purchase (sku or webId + qty).',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string', description: 'Local catalog sku.' },
                webId: { type: 'string', description: 'Web product id from web_product_search (WEB-...).' },
                qty: { type: 'number', description: 'Positive integer quantity.' },
              },
              required: ['qty'],
              additionalProperties: false,
            },
          },
          idempotencyKey: {
            type: 'string',
            description: 'Client-generated unique key (e.g. UUID). Same key = same transaction, never a double debit.',
          },
        },
        required: ['items', 'idempotencyKey'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_status',
      description: 'Fetch the current status of an order by its human-readable orderNumber (e.g. "RZM-000123").',
      parameters: {
        type: 'object',
        properties: {
          orderNumber: { type: 'string' },
        },
        required: ['orderNumber'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the LIVE web (real-time results, not the local catalog). Use for current events, product research, comparisons, prices in India, or anything the local catalog cannot answer. Returns real titles, URLs and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The web search query.' },
          maxResults: { type: 'number', description: 'Max results to return (default 5, max 10).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_product_search',
      description:
        'Search the LIVE web for REAL products with REAL images and current prices (India). Each result has a webId usable in create_order / checkout_and_pay items as {"webId": "WEB-XXXXXXXX", "qty": 1} to buy it with the sandbox wallet. Present products to the user with their image URLs in markdown: ![name](image).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Product query, e.g. "sony wh-1000xm5 headphones".' },
          maxPricePaise: { type: 'number', description: 'Only include products at or below this price (paise).' },
          maxResults: { type: 'number', description: 'Max products to return (default 6, max 10).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_purchase_otp',
      description:
        'Verify the 6-digit OTP for an awaiting_otp transaction (amount above the delegated limit). On success the guarded payment executes. For agent accounts the OTP is delivered inline in the checkout_and_pay response; for human accounts it arrives by email.',
      parameters: {
        type: 'object',
        properties: {
          transactionId: { type: 'string', description: 'The transactionId from the awaiting_otp response.' },
          otp: { type: 'string', description: 'The 6-digit code.' },
        },
        required: ['transactionId', 'otp'],
        additionalProperties: false,
      },
    },
  },
];

export const LLM_TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.function.name);
