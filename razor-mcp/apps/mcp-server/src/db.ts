/**
 * Mongoose connection (single cluster, replica set rs0 — transactions-capable).
 * Retry loop so the container survives Mongo's replica-set election window on boot.
 */
import mongoose from 'mongoose';

let connected = false;

export async function connectDb(uri: string): Promise<typeof mongoose> {
  const maxAttempts = 30;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
      });
      connected = true;
      console.log(`[mcp-server] mongo connected (attempt ${attempt})`);
      return conn;
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(500 * 2 ** (attempt - 1), 5000) * (0.85 + Math.random() * 0.3);
      console.warn(`[mcp-server] mongo connect attempt ${attempt}/${maxAttempts} failed — retrying in ${Math.round(backoff)}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr ?? new Error('mongo connect failed');
}

export function isDbConnected(): boolean {
  return connected && mongoose.connection.readyState === 1;
}

export function disconnectDb(): Promise<void> {
  return mongoose.disconnect();
}
