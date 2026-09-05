/** Initiate the single-node replica set + apply every repo index (mirrors infra/mongo-init/init.js). */
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', {
  serverSelectionTimeoutMS: 5000,
});
await client.connect();
const admin = client.db('admin');

try {
  const status = await admin.command({ replSetGetStatus: 1 });
  console.log('replSet already:', status?.members?.[0]?.stateStr);
} catch {
  console.log('initiating rs0 ...');
  await admin.command({
    replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017', priority: 1 }] },
  });
}

// wait for primary
for (let i = 0; i < 60; i++) {
  try {
    const hello = await admin.command({ hello: 1 });
    if (hello.isWritablePrimary) { console.log('PRIMARY_READY'); break; }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 500));
}

const d = client.db('razormcp');
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
await client.close();
process.exit(0);
