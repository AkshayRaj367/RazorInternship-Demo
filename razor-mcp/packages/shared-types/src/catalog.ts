/**
 * Catalog + orders contract.
 * Shared by: mcp-server (Mongoose models), agent-service (reads order docs for payment
 * state transitions — same cluster), web (product cards / order status display).
 */

export type OrderStatus =
  | 'created'
  | 'payment_pending'
  | 'paid'
  | 'payment_failed'
  | 'recovery_in_progress'
  | 'recovered'
  | 'cancelled'
  | 'expired';

/** catalog_items document (stock mutations are OCC-guarded via `version`). */
export interface CatalogItem {
  _id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
  stock: number;
  reservedStock: number;
  version: number;
  imageUrl: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One line of an order (immutable snapshot at checkout time).
 *  itemSource 'catalog': sku refers to the local catalog (stock-managed).
 *  itemSource 'web': sku holds a WEB-XXXXXXXX id with a live listing snapshot. */
export interface OrderItem {
  sku: string;
  itemSource?: 'catalog' | 'web';
  name: string;
  qty: number;
  unitPricePaise: number;
  lineTotalPaise: number;
  /** web item snapshot: product page, image, retailer, raw price text. */
  url?: string | null;
  image?: string | null;
  webSource?: string | null;
  priceText?: string | null;
}

/** orders document. */
export interface Order {
  _id: string;
  orderNumber: string;
  idempotencyKey: string;
  buyerAgentId: string;
  items: OrderItem[];
  totalPaise: number;
  orderSource?: 'catalog' | 'web' | 'mixed';
  status: OrderStatus;
  razorpayOrderId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Public projection of a catalog item for API/tool responses. */
export interface CatalogItemPublic {
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
  priceInr: string; // pre-formatted for display, e.g. "1,499.00"
  stock: number;
  imageUrl: string;
}

export interface OrderPublic {
  orderNumber: string;
  idempotencyKey: string;
  buyerAgentId: string;
  items: OrderItem[];
  totalPaise: number;
  orderSource?: 'catalog' | 'web' | 'mixed';
  status: OrderStatus;
  razorpayOrderId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** REST fallback response for GET /catalog. */
export interface CatalogListResponse {
  items: CatalogItemPublic[];
  count: number;
}

/** REST fallback response for POST /orders. */
export interface CreateOrderResponse extends OrderPublic {
  duplicate?: boolean; // true when an existing order was returned for the same idempotencyKey
}
