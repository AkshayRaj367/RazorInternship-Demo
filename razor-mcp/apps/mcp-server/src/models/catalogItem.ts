/**
 * catalog_items model — stock mutations are OCC-guarded via `version`
 * (every atomic $inc bumps it) and sku is unique-indexed.
 */
import mongoose, { Schema, type Model, type InferSchemaType } from 'mongoose';
import type { CatalogItem as ICatalogItem } from '@razor-mcp/shared-types';

const CatalogItemSchema = new Schema(
  {
    sku: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    category: { type: String, required: true, index: true, trim: true },
    /** Integer paise — never a float. */
    pricePaise: { type: Number, required: true, min: 1 },
    stock: { type: Number, required: true, min: 0 },
    reservedStock: { type: Number, required: true, default: 0, min: 0 },
    /** Optimistic-concurrency counter for stock mutation. */
    version: { type: Number, required: true, default: 0 },
    imageUrl: { type: String, required: true },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, collection: 'catalog_items' }
);

// mongo unique index already created by infra/mongo-init/init.js; the `unique: true`
// above aligns Mongoose with it (belt and suspenders).

export type CatalogItemDoc = InferSchemaType<typeof CatalogItemSchema> & { _id: mongoose.Types.ObjectId };

export const CatalogItem: Model<CatalogItemDoc> =
  (mongoose.models.CatalogItem as Model<CatalogItemDoc>) ?? mongoose.model<CatalogItemDoc>('CatalogItem', CatalogItemSchema);

/** Public projection — safe to hand to LLMs / browsers (drops internal counters). */
export function toPublicItem(doc: CatalogItemDoc): ICatalogItem {
  return {
    _id: String(doc._id),
    sku: doc.sku,
    name: doc.name,
    description: doc.description,
    category: doc.category,
    pricePaise: doc.pricePaise,
    stock: doc.stock,
    reservedStock: doc.reservedStock,
    version: doc.version,
    imageUrl: doc.imageUrl,
    isActive: doc.isActive,
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}
