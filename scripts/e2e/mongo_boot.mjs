/**
 * Sandbox E2E boot: single-node REPLICA SET via mongodb-memory-server.
 * The replica set is mandatory — the razor-mcp services rely on multi-document
 * transactions (ACID debit, all-or-nothing checkout).
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [
    { port: 27017, ip: '127.0.0.1', args: ['--bind_ip', '127.0.0.1'] },
  ],
});

console.log('MONGO_READY', rs.getUri('razormcp'));
console.log('REPLSET', rs.replSetOpts?.name ?? 'rs0default');

// Apply the repo's index set (mirrors infra/mongo-init/init.js).
import { MongoClient } from 'mongodb';
const client = new MongoClient(rs.getUri(), { directConnection: true });
const d = client.db('razormcp');

// ---- indexes (same as infra/mongo-init/init.js) ----
await d.collection('wallets').createIndex({ agentId: 1 }, { unique: true });
await d.collection('transactions').createIndex({ idempotencyKey: 1 }, { unique: true });
await d.collection('transactions').createIndex({ agentId: 1 });
await d.collection('transactions').createIndex(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { status: { $in: ['pending', 'awaiting_otp'] } } }
);
await d.collection('otp_challenges').createIndex({ transactionId: 1 }, { unique: true });
await d.collection('otp_challenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
await d.collection('catalog_items').createIndex({ sku: 1 }, { unique: true });
await d.collection('orders').createIndex({ orderNumber: 1 }, { unique: true });
await d.collection('orders').createIndex({ idempotencyKey: 1 }, { unique: true });
await d.collection('orders').createIndex({ buyerAgentId: 1 });
await d.collection('orders').createIndex({ razorpayOrderId: 1 }, { sparse: true });
await d.collection('webhook_events').createIndex({ razorpayEventId: 1 }, { unique: true });
await d.collection('recovery_sessions').createIndex({ sessionId: 1 }, { unique: true });
await d.collection('recovery_sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
await d.collection('audit_logs').createIndex({ sessionId: 1, timestamp: 1 });
await d.collection('audit_logs').createIndex({ agentId: 1 });
await d.collection('api_clients').createIndex({ apiKeyHash: 1 }, { unique: true });
await d.collection('agent_conversations').createIndex({ sessionId: 1 }, { unique: true });
console.log('INDEXES_OK');

// Keep the process (and the replica set) alive until killed.
setInterval(() => {}, 1 << 30);
