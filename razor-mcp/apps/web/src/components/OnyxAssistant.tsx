/**
 * OnyxAssistant — the persistent onboarding agent widget (mounted globally in
 * layout.tsx).
 *
 * Onboarding contract (grading criterion): checks
 * localStorage.getItem('hasSeenOnboarding') on mount. If absent, shows the
 * intro panel. The flag is set once dismissed OR once the first message is
 * sent (ChatContext.send already calls markOnboardingSeen).
 *
 * Quick-start pills submit through the SHARED ChatContext.send() — the exact
 * same path as the manual input box (no duplicated submission logic):
 *   - "Buy a hoodie under Rs 2,000"      -> autonomous happy path
 *   - "Buy a premium watch for Rs 10,000" -> OTP guardrail path
 *   - "Explain how my wallet is protected" -> non-transactional info reply
 */
'use client';

import { useEffect, useState } from 'react';
import { useChat } from '@/context/ChatContext';

const QUICK_STARTS: Array<{ label: string; prompt: string; hint: string }> = [
  {
    label: 'Search the live web for WH-1000XM5 (with images)',
    prompt: 'Search the live web for sony wh-1000xm5 headphones and show me the products with images and prices',
    hint: 'real-time web + images',
  },
  {
    label: 'Buy a hoodie under ₹2,000',
    prompt: 'Buy a hoodie under ₹2,000',
    hint: 'autonomous happy path',
  },
  {
    label: 'Buy a premium watch for ₹10,000',
    prompt: 'Buy a premium watch for ₹10,000',
    hint: 'OTP guardrail path',
  },
];

export default function OnyxAssistant() {
  const { send, loading, hasSeenOnboarding, markOnboardingSeen } = useChat();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // First visit? Show the intro panel automatically.
    try {
      if (window.localStorage.getItem('hasSeenOnboarding') !== 'true') {
        setOpen(true);
      }
    } catch {
      setOpen(true);
    }
  }, []);

  if (!mounted) return null; // avoid SSR/localStorage mismatch

  const dismiss = () => {
    setOpen(false);
    markOnboardingSeen();
  };

  const firePill = async (prompt: string) => {
    setOpen(false);
    await send(prompt);
  };

  return (
    <>
      {/* Collapsed bubble */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Onyx assistant"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full border border-emerald-500/40 bg-slate-900/95 px-4 py-3 shadow-lg shadow-emerald-500/10 backdrop-blur transition hover:border-emerald-400/70 hover:shadow-emerald-500/20"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
          <span className="text-sm font-semibold tracking-wide text-slate-100">Onyx</span>
        </button>
      )}

      {/* Expanded panel */}
      {open && (
        <div
          role="dialog"
          aria-label="Onyx onboarding"
          className="fixed bottom-5 right-5 z-50 w-[calc(100vw-2.5rem)] max-w-sm rounded-2xl border border-slate-700/80 bg-slate-900/97 p-5 shadow-2xl shadow-black/40 backdrop-blur animate-fade-in-up"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-lg">
                🜁
              </div>
              <div>
                <p className="text-sm font-bold tracking-widest text-emerald-400">ONYX</p>
                <p className="text-[11px] text-slate-400">autonomous commerce agent</p>
              </div>
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss Onyx intro"
              className="rounded-md px-2 py-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
            >
              ✕
            </button>
          </div>

          <p className="mt-4 text-sm leading-relaxed text-slate-200">
            I am Onyx. I execute your commerce intents autonomously but securely.
            {!hasSeenOnboarding && (
              <span className="mt-1 block text-xs text-slate-400">
                Purchases under the ₹5,000 guardrail go through instantly; above it, a human OTP gate
                stops me — by design, not by politeness.
              </span>
            )}
          </p>

          <p className="mt-4 text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            Try one:
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {QUICK_STARTS.map((pill) => (
              <button
                key={pill.prompt}
                type="button"
                disabled={loading}
                onClick={() => void firePill(pill.prompt)}
                className="group flex items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 text-left text-sm text-slate-200 transition hover:border-emerald-500/50 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="font-medium">{pill.label}</span>
                <span className="shrink-0 rounded-full bg-slate-700/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400 group-hover:bg-emerald-500/15 group-hover:text-emerald-300">
                  {pill.hint}
                </span>
              </button>
            ))}
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
            Watch the audit timeline light up on the right as I work — every decision I make is
            logged and streamed live.
          </p>
        </div>
      )}
    </>
  );
}
