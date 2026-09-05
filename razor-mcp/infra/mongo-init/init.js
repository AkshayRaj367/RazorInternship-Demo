// infra/mongo-init/init.js
// Runs ONCE on first container boot (docker-entrypoint-initdb.d), and is idempotent:
//   1. initiate the single-node replica set (rs0) so both Mongoose and PyMongo
//      can open multi-document ACID transactions,
//   2. wait until the node is a writable primary,
//   3. create every index required by the data model (safe to re-run).
// In mongosh, `rs` (replica set) and `db` (MONGO_INITDB_DATABASE=razormcp) are in scope.

const DB_NAME = 'razormcp';

// ---- 1. Replica set ----------------------------------------------------------
try {
  const status = rs.status();
  if (status && status.ok === 1 && status.members && status.members.some((m) => m.stateStr === 'PRIMARY')) {
    print('[init] replica set already initialized');
  } else {
    print('[init] initiating replica set rs0');
    rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017', priority: 1 }] });
  }
} catch (e) {
  // "already initialized" surfaces as an error on re-runs — safe to ignore.
  try {
    rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017', priority: 1 }] });
  } catch (e2) {
    print('[init] rs.initiate skipped: ' + e2.message);
  }
}

// ---- 2. Wait for a writable primary ------------------------------------------
let primaryReady = false;
for (let i = 0; i < 100; i++) {
  try {
    const hello = db.getSiblingDB('admin').runCommand({ hello: 1 });
    if (hello && (hello.isWritablePrimary || hello.ismaster)) {
      primaryReady = true;
      break;
    }
  } catch (e) {
    /* keep polling */
  }
  sleep(150);
}
if (!primaryReady) {
  throw new Error('[init] mongod never became a writable primary; aborting index creation');
}
print('[init] node is writable primary');

// ---- 3. Indexes (idempotent createIndexes) -----------------------------------
const d = db.getSiblingDB(DB_NAME);

// wallets
d.wallets.createIndex({ agentId: 1 }, { unique: true, name: 'wallets_agentId_unique' });

// transactions
//   idempotencyKey unique = replay-attack prevention (DB-level second line of defense)
d.transactions.createIndex({ idempotencyKey: 1 }, { unique: true, name: 'transactions_idempotencyKey_unique' });
d.transactions.createIndex({ agentId: 1 }, { name: 'transactions_agentId' });
//   TTL auto-clears stuck pending / awaiting_otp locks (partial filter, expireAfterSeconds 0
//   means "delete the doc at its own expiresAt")
d.transactions.createIndex(
  { expiresAt: 1 },
  {
    name: 'transactions_expiresAt_ttl',
    expireAfterSeconds: 0,
    partialFilterExpression: { status: { $in: ['pending', 'awaiting_otp'] } },
  }
);

// otp_challenges — one active challenge per transaction; 5-minute TTL
d.otp_challenges.createIndex({ transactionId: 1 }, { unique: true, name: 'otp_challenges_transactionId_unique' });
d.otp_challenges.createIndex({ expiresAt: 1 }, { name: 'otp_challenges_expiresAt_ttl', expireAfterSeconds: 0 });

// catalog_items
d.catalog_items.createIndex({ sku: 1 }, { unique: true, name: 'catalog_items_sku_unique' });

// orders
d.orders.createIndex({ orderNumber: 1 }, { unique: true, name: 'orders_orderNumber_unique' });
d.orders.createIndex({ idempotencyKey: 1 }, { unique: true, name: 'orders_idempotencyKey_unique' });
d.orders.createIndex({ buyerAgentId: 1 }, { name: 'orders_buyerAgentId' });
d.orders.createIndex({ razorpayOrderId: 1 }, { sparse: true, name: 'orders_razorpayOrderId' });

// webhook_events — duplicate-dispatch prevention
d.webhook_events.createIndex({ razorpayEventId: 1 }, { unique: true, name: 'webhook_events_eventId_unique' });

// recovery_sessions — 30-minute TTL, self-cleaning; orderId is a REFERENCE (cart is never copied)
d.recovery_sessions.createIndex({ sessionId: 1 }, { unique: true, name: 'recovery_sessions_sessionId_unique' });
d.recovery_sessions.createIndex({ expiresAt: 1 }, { name: 'recovery_sessions_expiresAt_ttl', expireAfterSeconds: 0 });

// audit_logs — durable trail, NO TTL; sorted read path is sessionId + timestamp
d.audit_logs.createIndex({ sessionId: 1, timestamp: 1 }, { name: 'audit_logs_sessionId_timestamp' });
d.audit_logs.createIndex({ agentId: 1 }, { name: 'audit_logs_agentId' });

// api_clients (mcp-server only)
d.api_clients.createIndex({ apiKeyHash: 1 }, { unique: true, name: 'api_clients_apiKeyHash_unique' });

// agent_conversations (agent-service only) — isolated per-session chat history
d.agent_conversations.createIndex({ sessionId: 1 }, { unique: true, name: 'agent_conversations_sessionId_unique' });

// ---- v2: login/rooms + realtime search ---------------------------------------

// users — one account per room; emails are unique login handles
d.users.createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' });

// email_codes — registration/verification codes, 10-minute TTL
d.email_codes.createIndex({ email: 1, purpose: 1 }, { name: 'email_codes_email_purpose' });
d.email_codes.createIndex({ expiresAt: 1 }, { name: 'email_codes_expiresAt_ttl', expireAfterSeconds: 0 });

// search_cache — realtime web-search payload cache, TTL deletes stale entries
d.search_cache.createIndex({ key: 1 }, { unique: true, name: 'search_cache_key_unique' });
d.search_cache.createIndex({ expiresAt: 1 }, { name: 'search_cache_expiresAt_ttl', expireAfterSeconds: 0 });
d.search_cache.createIndex(
  { 'payload.products.webId': 1 },
  { sparse: true, name: 'search_cache_webId' }
);

print('[init] all indexes created on ' + DB_NAME);
