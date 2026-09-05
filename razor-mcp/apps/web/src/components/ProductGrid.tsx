/**
 * ProductGrid — REAL live-web product cards rendered from web_product_search
 * tool results attached to an assistant message.
 *
 * Each card shows the actual product image (loaded live from the web), the
 * parsed price, the retailer, and a Buy button that submits a purchase prompt
 * through the shared ChatContext.send() — Onyx then checks out with sandbox
 * funds using the webId.
 */
'use client';

import { formatInr } from '@/lib/apiClient';

export interface WebProductCard {
  webId: string;
  name: string;
  pricePaise: number | null;
  priceText: string | null;
  source: string;
  url: string;
  image: string;
}

export default function ProductGrid({
  products,
  onBuy,
  disabled,
}: {
  products: WebProductCard[];
  onBuy: (product: WebProductCard) => void;
  disabled: boolean;
}) {
  if (!products || products.length === 0) return null;
  return (
    <div className="mt-2 grid gap-2.5 sm:grid-cols-2">
      {products.map((p) => (
        <div
          key={p.webId}
          className="flex gap-3 rounded-xl border border-slate-700/70 bg-slate-950/50 p-2.5 transition hover:border-emerald-500/40"
        >
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg border border-slate-700/60 bg-slate-900">
            {p.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.image}
                alt={p.name}
                referrerPolicy="no-referrer"
                loading="lazy"
                className="h-full w-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-600">no image</div>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate text-xs font-semibold text-slate-200" title={p.name}>
              {p.name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {p.pricePaise ? (
                <span className="rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-300">
                  {formatInr(p.pricePaise)}
                </span>
              ) : (
                <span className="rounded-full border border-slate-600/50 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-400">
                  price unknown
                </span>
              )}
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-[110px] truncate rounded-full border border-slate-600/50 px-2 py-0.5 text-[10px] text-slate-400 hover:text-emerald-300"
                title={p.url}
              >
                {p.source}
              </a>
            </div>
            <div className="mt-auto flex items-center gap-2 pt-2">
              <button
                type="button"
                disabled={disabled || !p.pricePaise}
                onClick={() => onBuy(p)}
                title={p.pricePaise ? 'Buy with sandbox funds' : 'No parsed price — not purchasable'}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-30"
              >
                Buy · sandbox funds
              </button>
              <span className="font-mono text-[9px] text-slate-600">{p.webId}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
