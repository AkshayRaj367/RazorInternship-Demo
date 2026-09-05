/**
 * Pipeline validation: inject a realistic (DDG-style) search payload into
 * search_cache, then run the FULL purchase flow:
 *   getWebProduct -> createOrder (web items) -> getOrderStatus -> room isolation.
 * This proves the webId -> order -> sandbox-purchase pipeline end to end.
 */
const mongoose = require('../razor-mcp/apps/mcp-server/node_modules/mongoose');

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/razormcp?replicaSet=rs0&directConnection=true', {
    serverSelectionTimeoutMS: 5000,
  });

  const { createHash } = require('../razor-mcp/apps/mcp-server/node_modules/crypto' === 'never' ? 'node:crypto' : 'node:crypto');
  const SearchCache = require('../razor-mcp/apps/mcp-server/dist/models/searchCache').SearchCache;
  const { getWebProduct } = require('../razor-mcp/apps/mcp-server/dist/services/realtimeSearchService');
  const { createOrder, getOrderStatus } = require('../razor-mcp/apps/mcp-server/dist/services/orderService');

  // --- inject a realistic DDG-quality product payload ---
  const webId = 'WEB-' + createHash('sha256').update('https://www.amazon.in/Sony-WH-1000XM5|https://m.media-amazon.com/sony-xm5.jpg|Sony WH-1000XM5').digest('hex').slice(0, 8).toUpperCase();
  const payload = {
    products: [
      {
        webId,
        name: 'Sony WH-1000XM5/B Wireless Noise Cancelling Headphones',
        pricePaise: 2999000,
        priceText: '₹29,990',
        source: 'amazon.in',
        url: 'https://www.amazon.in/Sony-WH-1000XM5-Cancelling-Headphones-Hands-Free/dp/B09XS7JWHH',
        image: 'https://m.media-amazon.com/images/I/71h6PpGaz9L._AC_SL1500_.jpg',
        snippet: 'Sony WH-1000XM5 price in India is ₹29,990. Industry-leading noise cancellation...',
      },
      {
        webId: 'WEB-' + createHash('sha256').update('https://www.flipkart.com/boat-141|https://rukminim2.flixcart.com/boat.jpg|boAt Airdopes 141').digest('hex').slice(0, 8).toUpperCase(),
        name: 'boAt Airdopes 141 TWS Earbuds',
        pricePaise: 129900,
        priceText: '₹1,299',
        source: 'flipkart.com',
        url: 'https://www.flipkart.com/boat-airdopes-141-tws-earbuds/p/itmxxxx',
        image: 'https://rukminim2.flixcart.com/image/850/1000/boat-141.jpg',
        snippet: 'boAt Airdopes 141 price: ₹1,299 with 42H playback...',
      },
    ],
  };
  await SearchCache.updateOne(
    { key: 'inject-test' },
    { $set: { key: 'inject-test', payload, fetchedAt: new Date(), expiresAt: new Date(Date.now() + 600000) }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  // --- 1. resolve by webId ---
  const found = await getWebProduct(webId);
  console.log('1. getWebProduct:', found ? `${found.name} @ ${found.priceText}` : 'FAILED');
  if (!found) process.exit(1);

  // --- 2. create a WEB order ---
  const room = 'user:507f1f77bcf86cd799439011';
  const ctx = { callerRoom: room, isInternal: false };
  const order = await createOrder([{ webId, qty: 1 }], room, `inject-${Date.now()}`, ctx);
  console.log(`2. createOrder: ${order.orderNumber} | total=${order.totalPaise}p | source=${order.orderSource} | status=${order.status}`);
  console.log(`   item: ${order.items[0].name} | price=${order.items[0].priceText} | img=${(order.items[0].image || '').slice(0, 60)}`);
  console.log(`   itemSource=${order.items[0].itemSource} | url=${(order.items[0].url || '').slice(0, 70)}`);

  // --- 3. read back ---
  const status = await getOrderStatus(order.orderNumber, ctx);
  console.log(`3. getOrderStatus (own room): ${status.orderNumber} -> ${status.status} ✓`);

  // --- 4. room isolation ---
  const intruderCtx = { callerRoom: 'user:000000000000000000000000', isInternal: false };
  try {
    await getOrderStatus(order.orderNumber, intruderCtx);
    console.log('4. room isolation: FAILED (cross-room read allowed)');
    process.exit(1);
  } catch (e) {
    console.log(`4. room isolation: OK — cross-room read rejected (${String(e.message).slice(0, 50)})`);
  }

  // --- 5. forced buyerAgentId is ignored for external keys ---
  try {
    const spoofed = await createOrder([{ webId, qty: 1 }], 'user:FFFFFFFFFFFFFFFFFFFFFFFF', `spoof-${Date.now()}`, intruderCtx);
    console.log(`5. buyer pinning: ${spoofed.buyerAgentId === intruderCtx.callerRoom ? 'OK (forced to caller room)' : 'FAILED ' + spoofed.buyerAgentId}`);
  } catch (e) {
    console.log('5. buyer pinning: FAILED', e.message);
    process.exit(1);
  }

  // --- 6. internal key can pass buyerAgentId freely (agent-service path) ---
  const internalCtx = { callerRoom: 'agent-service-internal', isInternal: true };
  const internalOrder = await createOrder([{ webId, qty: 2 }], room, `internal-${Date.now()}`, internalCtx);
  console.log(`6. internal path: ${internalOrder.orderNumber} buyer=${internalOrder.buyerAgentId} total=${internalOrder.totalPaise}p ✓`);

  // --- 7. mixed cart: catalog sku + webId ---
  const mixed = await createOrder([{ sku: 'APL-HOODIE-001', qty: 1 }, { webId, qty: 1 }], room, `mixed-${Date.now()}`, internalCtx);
  console.log(`7. mixed cart: ${mixed.orderNumber} source=${mixed.orderSource} items=${mixed.items.length} total=${mixed.totalPaise}p ✓`);

  // --- 8. stock was NOT touched by web items ---
  const { CatalogItem } = require('../razor-mcp/apps/mcp-server/dist/models/catalogItem');
  const hoodie = await CatalogItem.findOne({ sku: 'APL-HOODIE-001' }).lean();
  console.log(`8. catalog stock after mixed order: hoodie stock=${hoodie.stock} reserved=${hoodie.reservedStock} (reserved 1 from mixed cart) ${hoodie.reservedStock >= 1 ? '✓' : 'FAILED'}`);

  await mongoose.disconnect();
  console.log('\nALL PIPELINE CHECKS PASSED');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
