/**
 * RecoveryBanner — appears when the revenue-recovery agent pushes
 * 'recovery:alt_link' over the socket (payment.failed -> autonomous recovery).
 * CTA opens altPaymentLinkUrl (Razorpay TEST payment link) in a new tab.
 */
'use client';

import { useUiStore } from '@/store/auditStore';
import { formatInr } from '@/lib/apiClient';

export default function RecoveryBanner() {
  const recovery = useUiStore((s) => s.recoveryLink);
  const clear = useUiStore((s) => s.setRecoveryLink);

  if (!recovery) return null;

  const hasLink = typeof recovery.altPaymentLinkUrl === 'string' && recovery.altPaymentLinkUrl.length > 0;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[55] border-b border-fuchsia-600/50 bg-gradient-to-r from-fuchsia-950/95 via-slate-950/95 to-slate-950/95 px-4 py-3 backdrop-blur animate-fade-in-up"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2 rounded-full border border-fuchsia-600/50 bg-fuchsia-500/15 px-2.5 py-1 text-[10px] font-bold tracking-widest text-fuchsia-300">
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-fuchsia-400" />
          RECOVERY AGENT
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100">
            Payment failed{recovery.orderNumber ? ` for ${recovery.orderNumber}` : ''} — I&apos;ve
            already generated an alternative payment link.
          </p>
          <p className="truncate text-xs text-slate-400">
            Decline reason: <span className="font-mono">{recovery.declineReason || 'unknown'}</span>
            {!hasLink && recovery.reason ? (
              <>
                {' '}· <span className="font-mono">{recovery.reason}</span> (set Razorpay TEST keys to
                generate real links)
              </>
            ) : null}
          </p>
        </div>

        {hasLink ? (
          <a
            href={recovery.altPaymentLinkUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl bg-fuchsia-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-fuchsia-500"
          >
            Complete payment →
          </a>
        ) : (
          <span className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-400">
            Link unavailable
          </span>
        )}

        <button
          type="button"
          onClick={() => clear(null)}
          aria-label="Dismiss recovery banner"
          className="rounded-md px-2 py-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-200"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
