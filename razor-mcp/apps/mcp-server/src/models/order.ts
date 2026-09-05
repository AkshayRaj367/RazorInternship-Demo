/**
 * orders model — orderNumber and idempotencyKey are unique-indexed
 * (duplicate-checkout prevention at the DB level).
 *
 * v2: items may be LOCAL catalog items (sku) or LIVE web products (webId).
 * Web items carry their snapshot (name, url, image, source) and are NOT
 * stock-managed (the real retailer holds the stock; our sandbox just records
 * the intent + price-lock from the search cache).
 */
import mongoose, { Schema, type Model, type InferSchemaType } from 'mongoose';
import type { OrderItem, OrderPublic, OrderStatus } from '@razor-mcp/shared-types';

const OrderItemSchema = new Schema(
  {
    /** Local catalog sku ("APL-HOODIE-001") OR web product id ("WEB-1A2B3C4D"). */
    sku: { type: String, required: true },
    /** 'catalog' (stock-managed) or 'web' (live listing snapshot). */
    itemSource: { type: String, enum: ['catalog', 'web'], default: 'catalog' },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true, min: 1 },
    lineTotalPaise: { type: Number, required: true, min: 1 },
    // --- web-item snapshot (catalog items leave these null) ---
    url: { type: String, default: null },
    image: { type: String, default: null },
    webSource: { type: String, default: null },
    priceText: { type: String, default: null },
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    idempotencyKey: { type: String, required: true, unique: true },
    buyerAgentId: { type: String, required: true, index: true },
    items: { type: [OrderItemSchema], required: true },
    totalPaise: { type: Number, required: true, min: 1 },
    /** 'catalog' | 'web' | 'mixed' — what this order is made of. */
    orderSource: { type: String, enum: ['catalog', 'web', 'mixed'], default: 'catalog', index: true },
    status: {
      type: String,
      required: true,
      enum: ['created', 'payment_pending', 'paid', 'payment_failed', 'recovery_in_progress', 'recovered', 'cancelled', 'expired'],
      default: 'created',
    },
    razorpayOrderId: { type: String, default: null, index: true },
  },
  { timestamps: true, collection: 'orders' }
);

export type OrderDoc = InferSchemaType<typeof OrderSchema> & { _id: mongoose.Types.ObjectId };

export const Order: Model<OrderDoc> =
  (mongoose.models.Order as Model<OrderDoc>) ?? mongoose.model<OrderDoc>('Order', OrderSchema);

export function toPublicOrder(doc: OrderDoc): OrderPublic {
  return {
    orderNumber: doc.orderNumber,
    idempotencyKey: doc.idempotencyKey,
    buyerAgentId: doc.buyerAgentId,
    items: doc.items as OrderItem[],
    totalPaise: doc.totalPaise,
    orderSource: (doc.orderSource as 'catalog' | 'web' | 'mixed') ?? 'catalog',
    status: doc.status as OrderStatus,
    razorpayOrderId: doc.razorpayOrderId ?? null,
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}
