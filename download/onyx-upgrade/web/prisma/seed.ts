import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const P = (rupees: number) => Math.round(rupees * 100);

const products = [
  // Watches
  { sku: "ACC-WATCH-001", name: "Chrono Premier Automatic — Steel", category: "watches", description: "Sapphire crystal, 42h reserve, 316L steel case. Flagship automatic.", pricePaise: P(10000), marginPct: 38, stock: 12, rating: 4.7, tags: "watch,premium,automatic,steel,chrono,luxury", compatibleWith: "ACC-STRAP-001,ACC-STRAP-002,ACC-CARE-001" },
  { sku: "ACC-WATCH-002", name: "Meridian Chronograph — Onyx", category: "watches", description: "Matte black dial, tachymeter, sapphire glass.", pricePaise: P(6499), marginPct: 42, stock: 8, rating: 4.5, tags: "watch,chrono,black,onyx,sport", compatibleWith: "ACC-STRAP-001,ACC-STRAP-002" },
  { sku: "ACC-WATCH-003", name: "Horizon Minimal — Sand", category: "watches", description: "Ultra-thin quartz, 36mm, sand sunburst dial.", pricePaise: P(3299), marginPct: 45, stock: 22, rating: 4.4, tags: "watch,minimal,quartz,sand,everyday", compatibleWith: "ACC-STRAP-001" },
  // Apparel
  { sku: "APL-HOODIE-001", name: "Razor Fleece Hoodie — Charcoal", category: "apparel", description: "380 GSM brushed fleece, kangaroo pocket, ribbed cuffs.", pricePaise: P(1499), marginPct: 48, stock: 40, rating: 4.5, tags: "hoodie,fleece,charcoal,winter,unisex", compatibleWith: "APL-TEE-001,APL-CAP-001" },
  { sku: "APL-HOODIE-002", name: "Zip-Up Tech Hoodie — Slate", category: "apparel", description: "Water-repellent shell, hidden zip pockets.", pricePaise: P(1899), marginPct: 50, stock: 26, rating: 4.6, tags: "hoodie,zip,tech,slate,waterproof", compatibleWith: "APL-CAP-001" },
  { sku: "APL-TEE-001", name: "Circuit Tee — Off-White", category: "apparel", description: "240 GSM combed cotton, circuit print.", pricePaise: P(799), marginPct: 55, stock: 80, rating: 4.3, tags: "tee,tshirt,cotton,graphic", compatibleWith: "" },
  { sku: "APL-CAP-001", name: "Onyx Runner Cap — Black", category: "apparel", description: "Quick-dry 5-panel, reflective trim.", pricePaise: P(599), marginPct: 58, stock: 65, rating: 4.2, tags: "cap,hat,running,black", compatibleWith: "" },
  // Audio
  { sku: "AUD-EARB-001", name: "Razor Pods Pro", category: "audio", description: "ANC earbuds, 32h total, wireless charging case.", pricePaise: P(3499), marginPct: 44, stock: 30, rating: 4.6, tags: "earbuds,audio,anc,bluetooth,pods", compatibleWith: "AUD-CARE-001" },
  { sku: "AUD-HEAD-001", name: "Studio Over-Ears — Midnight", category: "audio", description: "Reference drivers, memory-foam cups, USB-C lossless.", pricePaise: P(8999), marginPct: 36, stock: 10, rating: 4.8, tags: "headphones,audio,studio,over-ear,hi-res", compatibleWith: "AUD-CARE-001" },
  { sku: "AUD-SPK-001", name: "Field Speaker 360 — Forest", category: "audio", description: "IP67 portable speaker, 18h battery, stereo pairing.", pricePaise: P(2599), marginPct: 47, stock: 18, rating: 4.4, tags: "speaker,bluetooth,portable,outdoor", compatibleWith: "" },
  // Accessories (upsell magnets)
  { sku: "ACC-STRAP-001", name: "Milano Leather Strap — Tan", category: "accessories", description: "Full-grain Italian leather, quick-release pins, fits all 20mm lugs.", pricePaise: P(1499), marginPct: 62, stock: 35, rating: 4.6, tags: "strap,leather,tan,watch-accessory,20mm", compatibleWith: "ACC-CARE-001" },
  { sku: "ACC-STRAP-002", name: "Steel Bracelet — Brushed", category: "accessories", description: "316L solid links, butterfly clasp, 20mm.", pricePaise: P(2199), marginPct: 58, stock: 20, rating: 4.5, tags: "bracelet,steel,watch-accessory,20mm", compatibleWith: "ACC-CARE-001" },
  { sku: "ACC-CARE-001", name: "Watch Care Kit — 6pc", category: "accessories", description: "Microfiber cloth, lug tool, polish, case back opener.", pricePaise: P(899), marginPct: 64, stock: 50, rating: 4.3, tags: "care,kit,cleaning,watch-accessory", compatibleWith: "" },
  { sku: "AUD-CARE-001", name: "Audio Care Bundle", category: "accessories", description: "Eartip set, cable organizer, travel pouch.", pricePaise: P(749), marginPct: 60, stock: 44, rating: 4.2, tags: "care,audio-accessory,pouch", compatibleWith: "" },
  { sku: "ACC-BAG-001", name: "Tech Sling — Graphite", category: "accessories", description: "Waterproof sling, RFID pocket, 4L.", pricePaise: P(1799), marginPct: 52, stock: 28, rating: 4.4, tags: "bag,sling,edc,waterproof", compatibleWith: "" },
  { sku: "ACC-PWR-001", name: "MagPod 10K Powerbank", category: "accessories", description: "10,000mAh magnetic pack, 20W PD.", pricePaise: P(2299), marginPct: 46, stock: 33, rating: 4.5, tags: "powerbank,magsafe,charging,travel", compatibleWith: "" },
  { sku: "APL-SOCK-001", name: "Trail Socks 3-Pack — Multi", category: "apparel", description: "Merino blend, arch compression.", pricePaise: P(499), marginPct: 66, stock: 90, rating: 4.1, tags: "socks,merino,3-pack", compatibleWith: "" },
  { sku: "ACC-BOTTLE-001", name: "Vessel 750ml — Matte Black", category: "accessories", description: "Double-wall steel, 24h cold.", pricePaise: P(999), marginPct: 57, stock: 47, rating: 4.3, tags: "bottle,steel,hydration", compatibleWith: "" },
  { sku: "AUD-CABLE-001", name: "USB-C Braided Cable 2m", category: "accessories", description: "100W e-marked, nylon braid.", pricePaise: P(699), marginPct: 63, stock: 75, rating: 4.4, tags: "cable,usbc,charging", compatibleWith: "" },
  { sku: "ACC-GIFT-001", name: "Signature Gift Box", category: "accessories", description: "Rigid box, ribbon, handwritten card.", pricePaise: P(399), marginPct: 70, stock: 120, rating: 4.8, tags: "gift,box,packaging", compatibleWith: "" },
];

async function main() {
  await db.order.deleteMany(); // cascades order items + OTP challenges
  await db.auditEvent.deleteMany();
  await db.campaign.deleteMany();
  await db.wallet.deleteMany();
  await db.product.deleteMany();

  for (const p of products) await db.product.create({ data: p });

  await db.wallet.create({
    data: {
      label: "Primary delegated wallet",
      balancePaise: P(18000),
      monthlyBudgetPaise: P(25000),
      spentThisMonthPaise: P(4850),
      trustScore: 60,
      baseLimitPaise: P(5000),
    },
  });

  await db.campaign.create({
    data: {
      name: "Weekend Watch Fest",
      type: "FLAT_PERCENT",
      scope: "category:watches",
      value: 15,
      budgetCapPaise: P(50000),
      impressions: 0,
      conversions: 0,
      status: "ACTIVE",
    },
  });

  await db.auditEvent.create({
    data: {
      type: "SYSTEM",
      summary: "Audit trail initialised — every money action will be recorded with full explainability",
      payload: JSON.stringify({ source: "seed", guardrails: ["budget_pacing", "velocity", "auto_approve_limit", "category_risk", "otp_gate", "trust_adaptive"] }),
    },
  });

  console.log(`Seeded ${products.length} products, 1 wallet, 1 active campaign.`);
}

main().finally(() => db.$disconnect());
