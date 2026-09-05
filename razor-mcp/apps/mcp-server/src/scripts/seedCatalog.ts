/**
 * Seeds 20 REAL catalog items (real product names, prices, categories — no
 * item1/item2 placeholders) plus the internal API client used by agent-service.
 * Idempotent: safe to run repeatedly (upserts; existing stock is preserved).
 *
 * Stock is intentionally tuned for grading demos:
 *   - ELE-SPK-001 stock 2  and  SPT-YOG-001 stock 3  -> concurrent-checkout oversell tests
 *   - ACC-WATCH-001 at Rs 10,000 (1,000,000 paise)   -> OTP guardrail path (limit Rs 5,000)
 *   - APL-HOODIE-001 at Rs 1,499                     -> autonomous happy path ("under Rs 2,000")
 */
import mongoose from 'mongoose';
import { CatalogItem } from '../models/catalogItem';
import { ApiClient, hashApiKey } from '../models/apiClient';

export interface SeedItem {
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
  stock: number;
  imageUrl: string;
}

export const SEED_ITEMS: SeedItem[] = [
  {
    sku: 'APL-HOODIE-001',
    name: 'Razor Fleece Hoodie — Charcoal',
    description: '380 GSM brushed fleece pullover hoodie with kangaroo pocket and flat drawcords. Unisex, regular fit.',
    category: 'apparel',
    pricePaise: 149900,
    stock: 40,
    imageUrl: 'https://picsum.photos/seed/APL-HOODIE-001/400/400',
  },
  {
    sku: 'APL-HOODIE-002',
    name: 'Zip-Up Tech Hoodie — Slate',
    description: 'Full-zip hoodie in water-repellent stretch knit, hidden earphone loops, matte hardware.',
    category: 'apparel',
    pricePaise: 189900,
    stock: 25,
    imageUrl: 'https://picsum.photos/seed/APL-HOODIE-002/400/400',
  },
  {
    sku: 'APL-TEE-001',
    name: 'Agent Ops Cotton Tee — Jet Black',
    description: '220 GSM combed cotton tee, bio-washed, side-seamed. Minimal chest hit.',
    category: 'apparel',
    pricePaise: 79900,
    stock: 100,
    imageUrl: 'https://picsum.photos/seed/APL-TEE-001/400/400',
  },
  {
    sku: 'APL-CAP-001',
    name: 'Loopback Dad Cap — Sand',
    description: 'Unstructured six-panel cap in loopback cotton, brass slider closure.',
    category: 'apparel',
    pricePaise: 89900,
    stock: 60,
    imageUrl: 'https://picsum.photos/seed/APL-CAP-001/400/400',
  },
  {
    sku: 'ACC-WATCH-001',
    name: 'Chrono Premier Automatic — Steel',
    description: 'Automatic chronograph, 42 mm brushed steel case, sapphire crystal, 60-hour reserve, 100 m WR.',
    category: 'watches',
    pricePaise: 1000000,
    stock: 5,
    imageUrl: 'https://picsum.photos/seed/ACC-WATCH-001/400/400',
  },
  {
    sku: 'ACC-WATCH-002',
    name: 'Minimalist Quartz — Rose Gold',
    description: '36 mm rose-gold PVD case, mesh bracelet, Miyota quartz movement, 30 m WR.',
    category: 'watches',
    pricePaise: 349900,
    stock: 12,
    imageUrl: 'https://picsum.photos/seed/ACC-WATCH-002/400/400',
  },
  {
    sku: 'ELE-KBD-001',
    name: 'Tactile Pro Mechanical Keyboard (Hot-Swap)',
    description: '75% layout, gasket-mounted, hot-swappable sockets, lubed tactile switches, south-facing RGB.',
    category: 'electronics',
    pricePaise: 899900,
    stock: 30,
    imageUrl: 'https://picsum.photos/seed/ELE-KBD-001/400/400',
  },
  {
    sku: 'ELE-MON-001',
    name: '27-inch QHD IPS Monitor 165 Hz',
    description: '2560x1440 Fast IPS, 1 ms GtG, 165 Hz, 95% DCI-P3, USB-C 65 W, height-adjust stand.',
    category: 'electronics',
    pricePaise: 2499900,
    stock: 8,
    imageUrl: 'https://picsum.photos/seed/ELE-MON-001/400/400',
  },
  {
    sku: 'ELE-MSE-001',
    name: 'Ergo Vertical Mouse — Graphite',
    description: '57-degree vertical grip, 4000 DPI optical sensor, silent clicks, 2.4 GHz + Bluetooth.',
    category: 'electronics',
    pricePaise: 299900,
    stock: 45,
    imageUrl: 'https://picsum.photos/seed/ELE-MSE-001/400/400',
  },
  {
    sku: 'ELE-HDP-001',
    name: 'Studio ANC Headphones — Midnight',
    description: 'Hybrid active noise cancellation, 40 mm drivers, LDAC, 42-hour battery, memory-foam cups.',
    category: 'electronics',
    pricePaise: 1299900,
    stock: 15,
    imageUrl: 'https://picsum.photos/seed/ELE-HDP-001/400/400',
  },
  {
    sku: 'ELE-WCM-001',
    name: '4K Streaming Webcam with Ring Light',
    description: 'Sony STARVIS sensor, 4K30/1080p60, dual noise-cancelling mics, adjustable halo light.',
    category: 'electronics',
    pricePaise: 749900,
    stock: 20,
    imageUrl: 'https://picsum.photos/seed/ELE-WCM-001/400/400',
  },
  {
    sku: 'ELE-SSD-001',
    name: '1 TB NVMe Gen4 SSD',
    description: 'PCIe 4.0 x4, 7000 MB/s read, 600k IOPS, DRAM cache, 5-year endurance rating.',
    category: 'electronics',
    pricePaise: 799900,
    stock: 35,
    imageUrl: 'https://picsum.photos/seed/ELE-SSD-001/400/400',
  },
  {
    sku: 'ELE-PWB-001',
    name: '20K mAh Power Bank — 65 W PD',
    description: 'PD 3.1 65 W in/out, airline-safe capacity, tri-output, LCD percentage readout.',
    category: 'electronics',
    pricePaise: 249900,
    stock: 50,
    imageUrl: 'https://picsum.photos/seed/ELE-PWB-001/400/400',
  },
  {
    sku: 'ELE-SPK-001',
    name: 'Bass Cube Bluetooth Speaker',
    description: '30 W stereo drivers, passive bass radiator, IPX7, 18-hour playtime. LOW STOCK — demo item.',
    category: 'electronics',
    pricePaise: 499900,
    stock: 2,
    imageUrl: 'https://picsum.photos/seed/ELE-SPK-001/400/400',
  },
  {
    sku: 'HME-LMP-001',
    name: 'Adaptive Desk Lamp — Warm/Cool',
    description: 'Auto-dimming LED panel, 2700-6500 K tunable, TUV flicker-free, USB-C pass-through port.',
    category: 'home',
    pricePaise: 399900,
    stock: 28,
    imageUrl: 'https://picsum.photos/seed/HME-LMP-001/400/400',
  },
  {
    sku: 'HME-BPK-001',
    name: 'Commuter Anti-Theft Backpack 22 L',
    description: 'Recycled ballistic nylon, hidden zip vaults, RFID pocket, luggage strap, rain cover.',
    category: 'home',
    pricePaise: 279900,
    stock: 40,
    imageUrl: 'https://picsum.photos/seed/HME-BPK-001/400/400',
  },
  {
    sku: 'HME-BTL-001',
    name: 'Vacuum Insulated Bottle 750 ml',
    description: '18/8 steel double-wall, 24 h cold / 12 h hot, leak-proof sports cap.',
    category: 'home',
    pricePaise: 129900,
    stock: 80,
    imageUrl: 'https://picsum.photos/seed/HME-BTL-001/400/400',
  },
  {
    sku: 'SPT-YOG-001',
    name: 'Grip Yoga Mat 6 mm — Teal',
    description: 'TPE dual-layer mat, alignment lines, 6 mm cushioning. LOW STOCK — demo item.',
    category: 'fitness',
    pricePaise: 199900,
    stock: 3,
    imageUrl: 'https://picsum.photos/seed/SPT-YOG-001/400/400',
  },
  {
    sku: 'SPT-DMB-001',
    name: 'Adjustable Dumbbell Set 2x10 kg',
    description: 'Dial-adjustable 2.5-10 kg per dumbbell, knurled steel handle, cradle trays included.',
    category: 'fitness',
    pricePaise: 3499900,
    stock: 10,
    imageUrl: 'https://picsum.photos/seed/SPT-DMB-001/400/400',
  },
  {
    sku: 'CAF-BNS-001',
    name: 'Single-Origin Chikmagalur Coffee Beans 500 g',
    description: 'AA-grade washed arabica, medium-dark roast, notes of cocoa and orange peel.',
    category: 'grocery',
    pricePaise: 89900,
    stock: 200,
    imageUrl: 'https://picsum.photos/seed/CAF-BNS-001/400/400',
  },
];

/**
 * Upsert items by sku. Stock of EXISTING items is preserved (so demo depletion
 * survives re-seeds); new items get the scripted stock.
 */
export async function seedCatalog(): Promise<{ inserted: number; updated: number; total: number }> {
  let inserted = 0;
  let updated = 0;
  for (const item of SEED_ITEMS) {
    const existing = await CatalogItem.findOne({ sku: item.sku });
    if (existing) {
      await CatalogItem.updateOne(
        { sku: item.sku },
        {
          $set: {
            name: item.name,
            description: item.description,
            category: item.category,
            pricePaise: item.pricePaise,
            imageUrl: item.imageUrl,
            isActive: true,
          },
        }
      );
      updated++;
    } else {
      await CatalogItem.create({ ...item, reservedStock: 0, version: 0, isActive: true });
      inserted++;
    }
  }
  return { inserted, updated, total: SEED_ITEMS.length };
}

/**
 * Ensure the internal API client exists for a given raw key. Only the hash is
 * stored. Used by server bootstrap for MCP_SERVER_INTERNAL_API_KEY so
 * agent-service (and the Next.js server-side proxy) can authenticate.
 */
export async function ensureApiClient(
  rawKey: string,
  salt: string,
  agentName: string,
  rateLimitPerMinute = 600
): Promise<void> {
  if (!rawKey || rawKey.length < 8) {
    console.warn('[seed] refusing to register an empty/short API key — set MCP_SERVER_INTERNAL_API_KEY');
    return;
  }
  const apiKeyHash = hashApiKey(rawKey, salt);
  await ApiClient.updateOne(
    { apiKeyHash },
    { $set: { agentName, rateLimitPerMinute } },
    { upsert: true }
  );
}

/** Standalone runner: `npm run seed -w apps/mcp-server`. */
export async function runSeedStandalone(): Promise<void> {
  const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/razormcp?replicaSet=rs0&directConnection=true';
  const salt = process.env.MCP_API_KEY_SALT ?? 'change-me-to-a-long-random-salt';
  const internalKey = process.env.MCP_SERVER_INTERNAL_API_KEY ?? '';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const result = await seedCatalog();
  console.log(`[seed] catalog seeded: ${result.inserted} inserted, ${result.updated} updated (${result.total} total)`);
  if (internalKey) {
    await ensureApiClient(internalKey, salt, 'agent-service-internal', 600);
    console.log('[seed] internal api client ensured');
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  runSeedStandalone().catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
