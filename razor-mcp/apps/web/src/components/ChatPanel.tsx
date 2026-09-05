/**
 * ChatPanel — the manual chat surface (left half of the split view).
 * Submits through the SHARED ChatContext.send() (same path as Onyx pills and
 * the ProductGrid Buy buttons).
 *
 * v2: assistant replies render as markdown (real product images included) and
 * web_product_search tool results render as interactive ProductGrid cards.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@/context/ChatContext';
import { formatInr } from '@/lib/apiClient';
import MarkdownText from '@/components/MarkdownText';
import ProductGrid, { type WebProductCard } from '@/components/ProductGrid';

function ToolChip({ name, result }: { name: string; result: Record<string, unknown> }) {
  const status = typeof result?.status === 'string' ? (result.status as string) : null;
  const amount = typeof result?.amountPaise === 'number' ? (result.amountPaise as number) : null;
  const tone =
    status === 'awaiting_otp' || status === 'awaiting_payment'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
      : status === 'failed' || status === 'rejected' || status === 'payment_failed'
        ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
        : status === 'pending' || status === 'completed' || status === 'paid'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-slate-600/60 bg-slate-800/60 text-slate-300';
  return (
    <div className={`mt-1.5 inline-flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] font-mono ${tone}`}>
      <span className="shrink-0 opacity-70">tool →</span>
      <span className="shrink-0 font-semibold">{name}</span>
      {status && <span className="opacity-80">· {status}</span>}
      {amount !== null && <span className="opacity-80">· {formatInr(amount)}</span>}
    </div>
  );
}

export default function ChatPanel() {
  const { messages, loading, send } = useChat();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || loading) return;
    setDraft('');
    void send(text);
  };

  const buyProduct = (p: WebProductCard) => {
    if (loading) return;
    void send(`Buy the ${p.name} (${formatInr(p.pricePaise)}) — webId ${p.webId}, qty 1.`);
  };

  return (
    <section
      aria-label="Onyx chat"
      className="flex h-[70vh] min-h-[540px] flex-col rounded-2xl border border-slate-700/60 bg-slate-900/60"
    >
      <header className="flex items-center justify-between border-b border-slate-700/60 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          <h2 className="text-sm font-semibold tracking-wide text-slate-200">Onyx — agent chat</h2>
        </div>
        <span className="text-[11px] text-slate-500">live web · guardrailed · audited</span>
      </header>

      <div ref={scrollRef} className="razor-scroll flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-5">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-slate-400">Ask Onyx to search the live web or buy something.</p>
            <p className="max-w-xs text-xs text-slate-600">
              e.g. “Search the web for sony wh-1000xm5 and show me pictures” or “What keyboards are under ₹9,000?”
            </p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'rounded-br-md bg-emerald-600/90 text-white'
                  : m.error
                    ? 'rounded-bl-md border border-rose-500/40 bg-rose-500/10 text-rose-200'
                    : 'rounded-bl-md border border-slate-700/60 bg-slate-800/80 text-slate-200'
              }`}
            >
              {m.role === 'assistant' ? <MarkdownText text={m.content} /> : <p className="whitespace-pre-wrap break-words">{m.content}</p>}
              {m.products && m.products.length > 0 && (
                <ProductGrid products={m.products} onBuy={buyProduct} disabled={loading} />
              )}
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {m.toolCalls.map((tc, i) => (
                    <ToolChip key={`${m.id}-tc-${i}`} name={tc.name} result={tc.result} />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-slate-700/60 bg-slate-800/80 px-4 py-3">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-400" />
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-400 [animation-delay:200ms]" />
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-400 [animation-delay:400ms]" />
              <span className="ml-1 text-[11px] text-slate-500">Onyx is thinking · tools may run…</span>
            </div>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-slate-700/60 p-3 sm:p-4">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit(e);
              }
            }}
            rows={1}
            placeholder="Message Onyx… (Enter to send, Shift+Enter for newline)"
            aria-label="Message Onyx"
            className="razor-scroll max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          />
          <button
            type="submit"
            disabled={loading || draft.trim().length === 0}
            className="h-[44px] shrink-0 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
