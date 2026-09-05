/**
 * search_cache model — TTL'd cache of live web-search payloads.
 *
 * Each doc: { key (sha256 of kind+query), payload, fetchedAt, expiresAt }.
 * `expiresAt` drives the Mongo TTL index (server-side delete); the service
 * ALSO freshness-checks `fetchedAt + SEARCH_CACHE_TTL_SECONDS` so a doc whose
 * TTL index lags is still treated as stale.
 */
import mongoose, { Schema, type Model, type InferSchemaType } from 'mongoose';

const SearchCacheSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    fetchedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'search_cache' }
);
SearchCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SearchCacheDoc = InferSchemaType<typeof SearchCacheSchema> & { _id: mongoose.Types.ObjectId };

export const SearchCache: Model<SearchCacheDoc> =
  (mongoose.models.SearchCache as Model<SearchCacheDoc>) ??
  mongoose.model<SearchCacheDoc>('SearchCache', SearchCacheSchema);

export function cacheExpiry(from: Date, ttlSeconds: number): Date {
  return new Date(from.getTime() + ttlSeconds * 1000);
}
