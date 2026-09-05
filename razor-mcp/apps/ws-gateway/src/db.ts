/**
 * Mongo connection for ws-gateway (official driver — read-only over audit_logs
 * for backlog replay). Retry loop survives the replica-set election window.
 */
import { MongoClient, type Db } from 'mongodb';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDb(uri: string): Promise<Db> {
  const maxAttempts = 30;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      db = client.db();
      await db.command({ ping: 1 });
      console.log(`[ws-gateway] mongo connected (attempt ${attempt})`);
      return db;
    } catch (err) {
      lastErr = err;
      client?.close().catch(() => undefined);
      client = null;
      db = null;
      const backoff = Math.min(500 * 2 ** (attempt - 1), 5000) * (0.85 + Math.random() * 0.3);
      console.warn(`[ws-gateway] mongo connect attempt ${attempt}/${maxAttempts} failed — retrying in ${Math.round(backoff)}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr ?? new Error('mongo connect failed');
}

export function getDb(): Db {
  if (!db) throw new Error('DB_NOT_CONNECTED');
  return db;
}

export function isDbConnected(): boolean {
  return db !== null && client !== null;
}

export async function disconnectDb(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}
