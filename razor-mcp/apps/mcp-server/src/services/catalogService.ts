/**
 * Catalog business logic — the ONE implementation behind both the MCP
 * search_catalog/get_item tools and the REST fallback GET /catalog, GET /catalog/:sku.
 */
import type { CatalogItemPublic, CatalogListResponse } from '@razor-mcp/shared-types';
import { CatalogItem, toPublicItem, type CatalogItemDoc } from '../models/catalogItem';

function formatInr(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toPublic(doc: CatalogItemDoc): CatalogItemPublic {
  const base = toPublicItem(doc);
  return {
    sku: base.sku,
    name: base.name,
    description: base.description,
    category: base.category,
    pricePaise: base.pricePaise,
    priceInr: `₹${formatInr(base.pricePaise)}`,
    stock: base.stock,
    imageUrl: base.imageUrl,
  };
}

export interface SearchArgs {
  query?: string;
  category?: string;
  maxPricePaise?: number;
}

export async function searchCatalog(args: SearchArgs): Promise<CatalogListResponse> {
  const filter: Record<string, unknown> = { isActive: true };
  if (args.query && typeof args.query === 'string' && args.query.trim().length > 0) {
    const rx = new RegExp(args.query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { description: rx }, { category: rx }, { sku: rx }];
  }
  if (args.category && typeof args.category === 'string' && args.category.trim().length > 0) {
    filter.category = args.category.trim();
  }
  if (typeof args.maxPricePaise === 'number' && Number.isFinite(args.maxPricePaise) && args.maxPricePaise > 0) {
    filter.pricePaise = { $lte: Math.floor(args.maxPricePaise) };
  }

  const docs = await CatalogItem.find(filter).sort({ pricePaise: 1 }).limit(50).lean<CatalogItemDoc[]>();
  return { items: docs.map(toPublic), count: docs.length };
}

export async function getItem(sku: string): Promise<CatalogItemPublic> {
  const doc = await CatalogItem.findOne({ sku, isActive: true }).lean<CatalogItemDoc>();
  if (!doc) {
    const e = new Error(`ITEM_NOT_FOUND: ${sku}`) as Error & { httpStatus?: number };
    e.httpStatus = 404;
    throw e;
  }
  return toPublic(doc);
}

export function isItemNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('ITEM_NOT_FOUND');
}
