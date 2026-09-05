/**
 * LIVE smoke test for the realtime search service + web-product orders.
 * Requires: mongod (rs0) on 127.0.0.1:27017 + internet access.
 */
const mongoose = require('../razor-mcp/apps/mcp-server/node_modules/mongoose');

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/razormcp?replicaSet=rs0&directConnection=true', {
    serverSelectionTimeoutMS: 5000,
  });
  console.log('mongo: connected');

  const { webSearch, webProductSearch, getWebProduct } = require('../razor-mcp/apps/mcp-server/dist/services/realtimeSearchService');
  const { createOrder, getOrderStatus } = require('../razor-mcp/apps/mcp-server/dist/services/orderService');
  const { seedCatalog } = require('../razor-mcp/apps/mcp-server/dist/scripts/seedCatalog');

  await seedCatalog();

  // ---- 1. plain web search ----
  console.log('\n=== web_search: "sony wh-1000xm5 price india" ===');
  const ws = await webSearch('sony wh-1000xm5 price india', 4);
  console.log(`engine=${ws.engine} cached=${ws.cached} count=${ws.count}`);
  for (const r of ws.results) console.log(` - [${r.source}] ${r.title}\n   ${r.url}`);

  // ---- 2. product search with images ----
  console.log('\n=== web_product_search: "sony wh-1000xm5 headphones" ===');
  const ps = await webProductSearch('sony wh-1000xm5 headphones', { maxResults: 5 });
  console.log(`engine=${ps.engine} cached=${ps.cached} count=${ps.count}`);
  for (const p of ps.products) {
    console.log(` - ${p.webId} | ${p.name}\n   price=${p.priceText} (${p.pricePaise}p) | src=${p.source}\n   img=${(p.image || 'NONE').slice(0, 90)}\n   url=${p.url}`);
  }

  // ---- 3. purchase a web product with the sandbox order flow ----
  const buyable = ps.products.find((p) => p.pricePaise && p.pricePaise > 0);
  if (!buyable) {
    console.log('\nno purchasable web product found — skipping order test');
  } else {
    console.log(`\n=== create_order with webId ${buyable.webId} ===`);
    const ctx = { callerRoom: 'user:507f1f77bcf86cd799439011', isInternal: false };
    const order = await createOrder(
      [{ webId: buyable.webId, qty: 1 }],
      'user:507f1f77bcf86cd799439011',
      `smoke-${Date.now()}`,
      ctx
    );
    console.log(`order ${order.orderNumber} total=${order.totalPaise}p source=${order.orderSource} status=${order.status}`);
    console.log(`item: ${order.items[0].name} | ${order.items[0].priceText} | img=${(order.items[0].image || '').slice(0, 80)}`);

    const status = await getOrderStatus(order.orderNumber, ctx);
    console.log(`get_order_status -> ${status.orderNumber} ${status.status}`);
  }

  // ---- 4. room isolation check ----
  const ps2 = ps.products.find((p) => p.pricePaise && p.pricePaise > 0);
  if (ps2) {
    const otherCtx = { callerRoom: 'user:000000000000000000000000', isInternal: false };
    try {
      await getOrderStatus((await createOrder([{ webId: ps2.webId, qty: 1 }], 'user:000000000000000000000000', `iso-${Date.now()}`, otherCtx)).orderNumber, ctx);
      console.log('\nroom isolation: FAILED — cross-room read allowed!');
    } catch (e) {
      console.log(`\nroom isolation: OK (cross-room read rejected: ${e.message.slice(0, 60)})`);
    }
  }

  // ---- 5. cache hit path ----
  const again = await webProductSearch('sony wh-1000xm5 headphones', { maxResults: 5 });
  console.log(`\ncache second call: cached=${again.cached} engine=${again.engine} count=${again.count}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
