/**
 * REAL-TIME web search service — keyless, multi-engine, cached.
 *
 * Implements web_search + web_product_search behind the MCP surface.
 *
 * Provider chain (first success wins, all keyless HTML endpoints):
 *   1. DuckDuckGo lite (lite.duckduckgo.com)      — clean table markup
 *   2. DuckDuckGo html (html.duckduckgo.com)      — POST endpoint
 *   3. Bing HTML      (www.bing.com/search)       — reliable, ck/a redirects
 *   4. Yahoo HTML     (search.yahoo.com/search)   — RU= redirects
 *   5. Google HTML    (www.google.com/search)     — last resort
 *
 * Redirects are unwrapped: Bing `&u=a1<base64>` and Yahoo `RU=<enc>` both
 * decode to the real destination URL before use.
 *
 * Images: Bing Images (www.bing.com/images/search) — each tile carries an
 * `m` attribute with JSON containing `murl` (direct media URL) + `purl`
 * (landing page). Images are matched to products by domain when possible.
 *
 * Caching: search_cache Mongo collection (TTL index, default 30 min) so
 * repeated queries don't hammer the engines and product webIds stay stable
 * within the cache window (stable webId = purchasable web item).
 *
 * Robustness: every engine call is timeout-bounded (AbortController); for
 * PRODUCT searches two engines race in parallel and their results are MERGED
 * (dedup by final URL, price-bearing results preferred). Total failure raises
 * WEB_SEARCH_UNAVAILABLE — the local catalog keeps working regardless.
 */
import { createHash } from 'node:crypto';
import type { WebProduct, WebResult } from '@razor-mcp/shared-types';
import { McpError } from '../mcp/errors';
import { SearchCache, type SearchCacheDoc } from '../models/searchCache';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 9000;
const CACHE_TTL_SECONDS = parseInt(process.env.SEARCH_CACHE_TTL_SECONDS ?? '1800', 10);
const WEB_SEARCH_ENABLED = (process.env.WEB_SEARCH_ENABLED ?? 'true').toLowerCase() === 'true';
const MAX_RESULTS_CAP = 10;

/** Retail domains that almost always carry exact prices. */
const SHOPPING_DOMAINS = [
  'amazon.', 'flipkart.', 'croma.', 'reliancedigital.', 'myntra.', 'tatacliq.',
  'nutraholic.', 'vijaysales.', ' Poorvika'.trim().toLowerCase(), 'poorvika.', 'samsung.com', 'mi.com', 'boat-lifestyle.', 'apple.com/in', 'noise.in', 'zebronics.',
];

/** Normalize a URL to a hostname label ("www.amazon.in" -> "amazon.in"). */
function sourceFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'web';
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Unwrap Bing's ck/a redirect: ...&u=a1<urlsafe-b64> -> real URL. */
function unwrapBingRedirect(rawUrl: string): string {
  const url = decodeEntities(rawUrl);
  if (!/bing\.com\/ck\//i.test(url)) return url;
  const m = url.match(/[?&]u=a1([A-Za-z0-9+/_=-]+)/);
  if (!m) return url;
  try {
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4 !== 0) b += '=';
    const decoded = Buffer.from(b, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** Unwrap Yahoo's redirect: .../RU=<enc>/RK=... -> real URL. */
function unwrapYahooRedirect(rawUrl: string): string {
  const url = decodeEntities(rawUrl);
  if (!/r\.search\.yahoo\.com/i.test(url)) return url;
  const m = url.match(/RU=([^/]+)\//);
  if (!m) return url;
  try {
    const decoded = decodeURIComponent(m[1]);
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** Unwrap DDG's l/?uddg= redirect. */
function unwrapDdgRedirect(url: string): string {
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  if (!uddg) return url;
  try {
    const decoded = decodeURIComponent(uddg[1]);
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9', ...(init?.headers ?? {}) },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Organic web results — per-engine parsers
// ---------------------------------------------------------------------------

interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

/** Bing organic results: <li class="b_algo"><h2><a href="URL">title</a></h2><p>snippet</p> */
function parseBing(html: string): RawResult[] {
  const out: RawResult[] = [];
  const blocks = html.split('<li class="b_algo"');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = unwrapBingRedirect(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/bing\.com\/ck\//i.test(url)) continue; // unwrap failed — skip opaque link
    const title = stripTags(link[2]);
    const snippetMatch =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/) ?? block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).slice(0, 320) : '';
    if (title) out.push({ title: title.slice(0, 200), url, snippet });
  }
  return out;
}

/** DDG lite: <a class="result-link" href="URL">title</a> ... snippet table cells. */
function parseDdgLite(html: string): RawResult[] {
  const out: RawResult[] = [];
  const blocks = html.split(/<a[^>]+class="result-link"/);
  for (let i = 1; i < blocks.length; i++) {
    const link = blocks[i].match(/[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = unwrapDdgRedirect(decodeEntities(link[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(link[2]);
    const snippet = stripTags(blocks[i].match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? '').slice(0, 320);
    if (title) out.push({ title: title.slice(0, 200), url, snippet });
  }
  return out;
}

/** DDG html (POST endpoint): <a class="result__a" href="URL"> + <a class="result__snippet">. */
function parseDdgHtml(html: string): RawResult[] {
  const out: RawResult[] = [];
  const blocks = html.split(/<a[^>]+class="result__a"/);
  for (let i = 1; i < blocks.length; i++) {
    const link = blocks[i].match(/[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = unwrapDdgRedirect(decodeEntities(link[1]));
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(link[2]);
    const snippet = stripTags(blocks[i].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '').slice(0, 320);
    if (title) out.push({ title: title.slice(0, 200), url, snippet });
  }
  return out;
}

/** Yahoo: <div class="dd fst algo ..."> blocks, title div anchors with RU= redirects. */
function parseYahoo(html: string): RawResult[] {
  const out: RawResult[] = [];
  const blocks = html.split(/class="dd (?:fst|lst) algo/);
  for (let i = 1; i < blocks.length; i++) {
    const link = blocks[i].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = unwrapYahooRedirect(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/yahoo\.com/i.test(url)) continue;
    const title = stripTags(link[2]);
    const snippet = stripTags(blocks[i].match(/<p[^>]*class="[^"]*fz-ms[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? blocks[i].match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '').slice(0, 320);
    if (title) out.push({ title: title.slice(0, 200), url, snippet });
  }
  return out;
}

/** Google HTML fallback: anchors wrapping <h3>. */
function parseGoogle(html: string): RawResult[] {
  const out: RawResult[] = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]);
    if (/google\.|gstatic|youtube\.com\/results|support\.google/i.test(url)) continue;
    const title = stripTags(m[2]);
    if (title) out.push({ title: title.slice(0, 200), url, snippet: '' });
  }
  return out;
}

interface EngineSpec {
  engine: string;
  run: (query: string) => Promise<RawResult[]>;
}

const ENGINES: EngineSpec[] = [
  {
    engine: 'duckduckgo',
    run: async (q) => parseDdgLite(await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`)),
  },
  {
    engine: 'duckduckgo',
    run: async (q) =>
      parseDdgHtml(
        await fetchText('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `q=${encodeURIComponent(q)}`,
        })
      ),
  },
  {
    engine: 'bing',
    run: async (q) =>
      parseBing(await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=20&mkt=en-IN&cc=IN&setlang=en-in`)),
  },
  {
    engine: 'yahoo',
    run: async (q) => parseYahoo(await fetchText(`https://search.yahoo.com/search?p=${encodeURIComponent(q)}`)),
  },
  {
    engine: 'google',
    run: async (q) => parseGoogle(await fetchText(`https://www.google.com/search?q=${encodeURIComponent(q)}&num=20&hl=en&gl=in`)),
  },
];

/** Sequential single-engine search (used by web_search). */
async function organicSearch(query: string): Promise<{ results: RawResult[]; engine: string }> {
  let lastEngine = 'none';
  for (const engine of ENGINES) {
    try {
      const results = await engine.run(query);
      if (results.length >= 2) return { results, engine: engine.engine };
      lastEngine = engine.engine;
    } catch {
      // fall through to the next engine
    }
  }
  throw new McpError(-32000, 'WEB_SEARCH_UNAVAILABLE', { hint: `All search engines failed or blocked (last: ${lastEngine}).` }, 503);
}

/** Parallel multi-engine search with merge (used by web_product_search). */
async function organicSearchMerged(queries: string[]): Promise<{ results: RawResult[]; engines: string[] }> {
  // Race 3 engines across the query variants; merge + dedupe.
  const tasks: Array<Promise<{ results: RawResult[]; engine: string }>> = [];
  for (const engine of ENGINES.slice(0, 3)) {
    for (const q of queries.slice(0, 2)) {
      tasks.push(
        engine.run(q).then((results) => ({ results, engine: engine.engine })).catch(() => ({ results: [] as RawResult[], engine: engine.engine }))
      );
    }
  }
  const settled = await Promise.all(tasks);
  const seen = new Map<string, RawResult>();
  const engines = new Set<string>();
  for (const { results, engine } of settled) {
    if (results.length > 0) engines.add(engine);
    for (const r of results) {
      const key = r.url.replace(/\/+$/, '').toLowerCase();
      if (!seen.has(key)) seen.set(key, r);
      else {
        // merge snippets — a result seen twice with a longer snippet wins
        const prev = seen.get(key)!;
        if (r.snippet.length > prev.snippet.length) seen.set(key, { ...prev, snippet: r.snippet, title: prev.title || r.title });
      }
    }
  }
  const all = [...seen.values()];
  if (all.length === 0) {
    throw new McpError(-32000, 'WEB_SEARCH_UNAVAILABLE', { hint: 'All search engines failed or blocked from this host.' }, 503);
  }
  return { results: all, engines: [...engines] };
}

// ---------------------------------------------------------------------------
// Image search — Bing Images
// ---------------------------------------------------------------------------

interface RawImage {
  image: string;
  pageUrl: string;
  thumb: string;
}

async function imageSearch(query: string, limit: number): Promise<RawImage[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://www.bing.com/images/search?q=${encoded}&form=HDRSC2&first=1&count=60`;
  const html = await fetchText(url);
  const out: RawImage[] = [];
  const seen = new Set<string>();
  // Each tile: <a class="iusc" ... m="{&quot;murl&quot;:&quot;https://...&quot;,...}">
  const re = /class="iusc"[^>]*\sm="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit * 3) {
    try {
      const json = JSON.parse(decodeEntities(m[1])) as { murl?: string; purl?: string; turl?: string };
      const image = json.murl ?? '';
      if (!/^https?:\/\//i.test(image)) continue;
      if (seen.has(image)) continue;
      seen.add(image);
      out.push({ image, pageUrl: json.purl ?? '', thumb: json.turl ?? '' });
    } catch {
      // malformed tile — skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Price extraction (INR)
// ---------------------------------------------------------------------------

const PRICE_RE = /(?:₹|Rs\.?\s?|INR\s?)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;

/** Extract the most plausible INR price from title+snippet, in paise. */
export function extractPricePaise(text: string): { paise: number; text: string } | null {
  const found: Array<{ paise: number; text: string; idx: number }> = [];
  let m: RegExpExecArray | null;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, '');
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 10_000_000) continue;
    found.push({ paise: Math.round(value * 100), text: m[0].trim(), idx: m.index });
  }
  if (found.length === 0) return null;
  // Prefer prices that appear more than once (confidence), then earliest.
  const counts = new Map<number, number>();
  for (const f of found) counts.set(f.paise, (counts.get(f.paise) ?? 0) + 1);
  let best = found[0];
  let bestScore = -1;
  for (const f of found) {
    const score = (counts.get(f.paise) ?? 0) * 1_000_000 - f.idx;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

/** Clean a result title into a product-ish name. */
function toProductName(title: string): string {
  return (
    title
      .replace(/\s*[-–|]\s*(?:price|buy|online|best price|amazon|flipkart|croma|reliance digital|myntra|tata cliq).*/i, '')
      .replace(/\s*[-–|]\s*$/, '')
      .trim()
      .slice(0, 140) || title.slice(0, 140)
  );
}

function isShoppingish(url: string): boolean {
  const host = sourceFromUrl(url);
  return SHOPPING_DOMAINS.some((d) => host.includes(d));
}

function isJunkUrl(url: string): boolean {
  return /youtube\.|wikipedia\.|reddit\.|quora\.|\.gov|facebook\.|twitter\.|x\.com|instagram\.|linkedin\.|pinterest\.|yahoo\.com\/(?:news|entertainment)/i.test(url);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheKey(kind: string, query: string, extra: Record<string, unknown> = {}): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${kind}|${normalized}|${JSON.stringify(extra)}`).digest('hex');
}

function assignWebIds(products: Array<Omit<WebProduct, 'webId'>>): WebProduct[] {
  return products.map((p) => {
    const hash = createHash('sha256').update(`${p.url}|${p.image}|${p.name}`).digest('hex').slice(0, 8).toUpperCase();
    return { ...p, webId: `WEB-${hash}` };
  });
}

async function readCache<T>(key: string): Promise<T | null> {
  const doc = await SearchCache.findOne({ key }).lean<SearchCacheDoc>();
  if (!doc) return null;
  const freshAt = new Date(doc.fetchedAt).getTime() + CACHE_TTL_SECONDS * 1000;
  if (Date.now() > freshAt) return null;
  return doc.payload as T;
}

async function writeCache(key: string, payload: unknown): Promise<void> {
  const now = new Date();
  await SearchCache.updateOne(
    { key },
    { $set: { key, payload, fetchedAt: now, expiresAt: new Date(now.getTime() + CACHE_TTL_SECONDS * 1000) }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

// In-flight dedup: concurrent identical queries share one live fetch.
const inflight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, live: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
  const hit = await readCache<T>(key);
  if (hit !== null) return { value: hit, cached: true };
  const existing = inflight.get(key);
  if (existing) return { value: (await existing) as T, cached: true };
  const p = (async () => {
    const value = await live();
    await writeCache(key, value);
    return value;
  })();
  inflight.set(key, p);
  try {
    return { value: (await p) as T, cached: false };
  } finally {
    inflight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API — the service behind the MCP tools
// ---------------------------------------------------------------------------

function organicToWebResult(r: RawResult): WebResult {
  return { title: r.title, url: r.url, snippet: r.snippet, source: sourceFromUrl(r.url) };
}

export async function webSearch(query: string, maxResults = 5): Promise<{
  results: WebResult[];
  count: number;
  query: string;
  engine: string;
  cached: boolean;
}> {
  if (!WEB_SEARCH_ENABLED) {
    throw new McpError(-32000, 'WEB_SEARCH_DISABLED', { hint: 'Set WEB_SEARCH_ENABLED=true on mcp-server.' }, 503);
  }
  const limit = Math.max(1, Math.min(Math.floor(maxResults) || 5, MAX_RESULTS_CAP));
  const key = cacheKey('web', query);
  const { value, cached: isCached } = await cached(key, async () => {
    const { results, engine } = await organicSearch(query);
    return { results: results.slice(0, limit).map(organicToWebResult), engine };
  });
  const v = value as { results: WebResult[]; engine: string };
  return { results: v.results, count: v.results.length, query, engine: v.engine, cached: isCached };
}

export async function webProductSearch(
  query: string,
  opts: { maxResults?: number; maxPricePaise?: number } = {}
): Promise<{
  products: WebProduct[];
  count: number;
  query: string;
  engine: string;
  cached: boolean;
  note?: string;
}> {
  if (!WEB_SEARCH_ENABLED) {
    throw new McpError(-32000, 'WEB_SEARCH_DISABLED', { hint: 'Set WEB_SEARCH_ENABLED=true on mcp-server.' }, 503);
  }
  const limit = Math.max(1, Math.min(Math.floor(opts.maxResults ?? 6), MAX_RESULTS_CAP));
  const key = cacheKey('product', query, { limit });

  const { value, cached: isCached } = await cached(key, async () => {
    // 1) Multi-engine organic search across query variants, merged + deduped.
    const variants = [`${query} price`, `${query} buy online india price`];
    const { results, engines } = await organicSearchMerged(variants);

    // 2) Real images for the same query (fail-open: images are enhancements).
    let images: RawImage[] = [];
    try {
      images = await imageSearch(`${query} product`, limit * 3);
    } catch {
      images = [];
    }

    // 3) Score & rank organic results for product-ness.
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const scored = results
      .filter((r) => !isJunkUrl(r.url))
      .map((r) => {
        const price = extractPricePaise(`${r.title} ${r.snippet}`);
        let score = 0;
        if (price) score += 4;
        if (isShoppingish(r.url)) score += 3;
        const haystack = `${r.title} ${r.snippet}`.toLowerCase();
        for (const w of queryWords) if (haystack.includes(w)) score += 0.5;
        return { r, price, score };
      })
      .sort((a, b) => b.score - a.score);

    const products: Array<Omit<WebProduct, 'webId'>> = [];
    const usedImages = new Set<string>();

    // Pass A — priced organic results (purchasable), best image match first.
    for (const s of scored) {
      if (products.length >= limit) break;
      if (!s.price) continue;
      const host = sourceFromUrl(s.r.url);
      // Prefer an image whose landing page comes from the same domain.
      const img =
        images.find((i) => !usedImages.has(i.image) && sourceFromUrl(i.pageUrl) === host) ??
        images.find((i) => !usedImages.has(i.image));
      const image = img?.image ?? '';
      if (img) usedImages.add(img.image);
      products.push({
        name: toProductName(s.r.title),
        pricePaise: s.price.paise,
        priceText: s.price.text,
        source: host,
        url: s.r.url,
        image,
        snippet: s.r.snippet.slice(0, 220),
      });
    }

    // Pass B — image-backed listings (real image + landing page, price unknown).
    for (const img of images) {
      if (products.length >= limit) break;
      if (usedImages.has(img.image)) continue;
      if (!img.pageUrl || !/^https?:\/\//i.test(img.pageUrl) || isJunkUrl(img.pageUrl)) continue;
      usedImages.add(img.image);
      const host = sourceFromUrl(img.pageUrl);
      products.push({
        name: `${query} — ${host} listing`,
        pricePaise: null,
        priceText: null,
        source: host,
        url: img.pageUrl,
        image: img.image,
        snippet: 'Live web listing — price not parsed.',
      });
    }

    return { products: assignWebIds(products), engine: engines.join('+') || 'images' };
  });

  const v = value as { products: WebProduct[]; engine: string };
  let products = v.products;
  if (opts.maxPricePaise && Number.isFinite(opts.maxPricePaise) && opts.maxPricePaise > 0) {
    products = products.filter((p) => p.pricePaise === null || p.pricePaise <= Math.floor(opts.maxPricePaise!));
  }
  return {
    products,
    count: products.length,
    query,
    engine: v.engine,
    cached: isCached,
    note: 'Real live-web listings. Products with a price are purchasable — pass {"webId": "...", "qty": 1} to checkout_and_pay.',
  };
}

/** Look up one cached web product by webId (used by order creation). */
export async function getWebProduct(webId: string): Promise<WebProduct | null> {
  if (!/^WEB-[A-F0-9]{8}$/i.test(webId)) return null;
  const docs = await SearchCache.find({ 'payload.products.webId': webId }).lean<SearchCacheDoc[]>();
  for (const doc of docs) {
    const payload = doc.payload as { products?: WebProduct[] };
    const hit = payload.products?.find((p) => p.webId?.toUpperCase() === webId.toUpperCase());
    if (hit) return hit;
  }
  return null;
}
