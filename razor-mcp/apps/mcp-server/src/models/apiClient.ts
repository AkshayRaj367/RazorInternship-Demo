/**
 * api_clients model — external AI buyers that may call the MCP surface.
 * Only the SHA-256 hash of an API key is ever stored, never the key itself.
 */
import mongoose, { Schema, type Model, type InferSchemaType } from 'mongoose';

const ApiClientSchema = new Schema(
  {
    apiKeyHash: { type: String, required: true, unique: true },
    agentName: { type: String, required: true, trim: true },
    rateLimitPerMinute: { type: Number, required: true, default: 60, min: 1 },
  },
  { timestamps: true, collection: 'api_clients' }
);

export type ApiClientDoc = InferSchemaType<typeof ApiClientSchema> & { _id: mongoose.Types.ObjectId };

export const ApiClient: Model<ApiClientDoc> =
  (mongoose.models.ApiClient as Model<ApiClientDoc>) ?? mongoose.model<ApiClientDoc>('ApiClient', ApiClientSchema);

/** sha256(salt:key) — the ONLY thing persisted. */
export function hashApiKey(rawKey: string, salt: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(`${salt}:${rawKey}`).digest('hex');
}

export type { ApiClientDoc as ApiClientDocument };
