/**
 * AuditTimeline — the RazorSense live dashboard (right half of the split view).
 *
 * Renders the [Intent] → [Inventory Lock] → [Guardrail] → [Order] stepper,
 * color-coded per step, with the OTP gate and the recovery path rendered as
 * VISUALLY DISTINCT branches (indent + border + tag) off the happy path.
 * Source of events: the persisted audit store (localStorage hydration first,
 * server backlog reconciliation on socket join, live audit:event appends).
 */
'use client';

import { useState } from 'react';
import { useAuditStore } from '@/store/auditStore';
import { AuditStepEnum, type AuditLogEntry } from '@razor-mcp/shared-types';
import { formatInr } from '@/lib/apiClient';
import type { SocketStatus } from '@/hooks/useSocket';

interface StepMeta {
  label: string;
  dot: string; // tailwind bg-* for the status dot
  ring: string; // border tone for the card
  text: string; // title color
  branch: 'main' | 'otp' | 'recovery';
}

const STEP_META: Record<string, StepMeta> = {
  [AuditStepEnum.INTENT]: { label: 'Intent', dot: 'bg-slate-400', ring: 'border-slate-700/70', text: 'text-slate-200', branch: 'main' },
  [AuditStepEnum.INVENTORY_LOCK]: { label: 'Inventory Lock', dot: 'bg-cyan-400', ring: 'border-cyan-700/50', text: 'text-cyan-200', branch: 'main' },
  [AuditStepEnum.GUARDRAIL_PASS]: { label: 'Guardrail Pass', dot: 'bg-emerald-400', ring: 'border-emerald-700/50', text: 'text-emerald-200', branch: 'main' },
  [AuditStepEnum.GUARDRAIL_OTP_REQUIRED]: { label: 'Guardrail — OTP Required', dot: 'bg-amber-400', ring: 'border-amber-600/60', text: 'text-amber-200', branch: 'otp' },
  [AuditStepEnum.OTP_VERIFIED]: { label: 'OTP Verified', dot: 'bg-emerald-400', ring: 'border-amber-600/50', text: 'text-emerald-200', branch: 'otp' },
  [AuditStepEnum.ORDER_GENERATED]: { label: 'Order Generated', dot: 'bg-violet-400', ring: 'border-violet-700/50', text: 'text-violet-200', branch: 'main' },
  [AuditStepEnum.PAYMENT_FAILED]: { label: 'Payment Failed', dot: 'bg-rose-500', ring: 'border-rose-700/60', text: 'text-rose-200', branch: 'recovery' },
  [AuditStepEnum.RECOVERY_INITIATED]: { label: 'Recovery Initiated', dot: 'bg-fuchsia-400', ring: 'border-fuchsia-700/50', text: 'text-fuchsia-200', branch: 'recovery' },
  [AuditStepEnum.RECOVERY_LINK_SENT]: { label: 'Recovery Link Sent', dot: 'bg-fuchsia-400', ring: 'border-fuchsia-700/50', text: 'text-fuchsia-200', branch: 'recovery' },
  [AuditStepEnum.ORDER_COMPLETED]: { label: 'Order Completed', dot: 'bg-emerald-500', ring: 'border-emerald-700/60', text: 'text-emerald-200', branch: 'main' },
  [AuditStepEnum.ORDER_CANCELLED]: { label: 'Order Cancelled', dot: 'bg-slate-500', ring: 'border-slate-700/70', text: 'text-slate-300', branch: 'recovery' },
};

const BRANCH_TAG: Record<StepMeta['branch'], { label: string; className: string } | null> = {
  main: null,
  otp: { label: 'OTP GATE', className: 'bg-amber-500/15 text-amber-300 border-amber-600/40' },
  recovery: { label: 'RECOVERY PATH', className: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-600/40' },
};

function detailLine(entry: AuditLogEntry): string | null {
  const d = (entry.detail ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof d.orderNumber === 'string') parts.push(d.orderNumber);
  if (typeof d.amountPaise === 'number') parts.push(formatInr(d.amountPaise));
  if (typeof d.declineReason === 'string' && d.declineReason) parts.push(String(d.declineReason).slice(0, 60));
  if (typeof d.reason === 'string' && d.reason) parts.push(String(d.reason).slice(0, 60));
  if (typeof d.prompt === 'string' && d.prompt) parts.push(`“${String(d.prompt).slice(0, 48)}”`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function StepCard({ entry }: { entry: AuditLogEntry }) {
  const meta = STEP_META[entry.step] ?? {
    label: entry.step,
    dot: 'bg-slate-400',
    ring: 'border-slate-700/70',
    text: 'text-slate-200',
    branch: 'main' as const,
  };
  const [open, setOpen] = useState(false);
  const branchTag = BRANCH_TAG[meta.branch];
  const line = detailLine(entry);

  return (
    <li
      className={`relative pl-7 ${meta.branch !== 'main' ? 'ml-5 sm:ml-7 border-l-2 border-dashed border-slate-700/60' : ''}`}
    >
      {/* status dot on the spine */}
      <span
        aria-hidden
        className={`absolute -left-[7px] top-4 h-3.5 w-3.5 rounded-full border-2 border-slate-950 ${meta.dot}`}
      />
      <div className={`rounded-xl border ${meta.ring} bg-slate-900/70 p-3 transition hover:bg-slate-900`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={open}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={`text-[13px] font-semibold ${meta.text}`}>{meta.label}</span>
            {branchTag && (
              <span className={`rounded border px-1.5 py-px text-[9px] font-bold tracking-widest ${branchTag.className}`}>
                {branchTag.label}
              </span>
            )}
          </div>
          <span className="shrink-0 font-mono text-[10px] text-slate-500">{formatTime(entry.timestamp)}</span>
        </button>
        {line && <p className="mt-1 truncate font-mono text-[11px] text-slate-400">{line}</p>}
        {open && (
          <pre className="razor-scroll mt-2 max-h-48 overflow-auto rounded-lg bg-slate-950/80 p-2.5 font-mono text-[10px] leading-relaxed text-slate-400">
            {JSON.stringify(entry.detail ?? {}, null, 2)}
          </pre>
        )}
      </div>
    </li>
  );
}

export default function AuditTimeline({ status }: { status: SocketStatus }) {
  const events = useAuditStore((s) => s.events);

  const liveTone =
    status === 'connected'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-600/40'
      : status === 'reconnecting'
        ? 'bg-amber-500/15 text-amber-300 border-amber-600/40'
        : 'bg-slate-500/15 text-slate-400 border-slate-600/40';

  return (
    <section
      aria-label="Audit timeline"
      className="flex h-[70vh] min-h-[540px] flex-col rounded-2xl border border-slate-700/60 bg-slate-900/60"
    >
      <header className="flex items-center justify-between border-b border-slate-700/60 px-5 py-3.5">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">RazorSense — audit trail</h2>
        <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-widest ${liveTone}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${status === 'connected' ? 'bg-emerald-400' : 'bg-slate-400'} animate-pulse-dot`} />
          {status === 'connected' ? 'LIVE' : status.toUpperCase()}
        </span>
      </header>

      <div className="razor-scroll flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {events.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-slate-400">No audit events yet.</p>
            <p className="max-w-xs text-xs text-slate-600">
              Every intent, inventory lock, guardrail decision, and recovery step will stream here in
              real time — and survives a refresh.
            </p>
          </div>
        ) : (
          <ol className="relative space-y-3 border-l border-slate-700/70 pl-2">
            {events.map((e) => (
              <StepCard key={e._id} entry={e} />
            ))}
          </ol>
        )}
      </div>

      <footer className="border-t border-slate-700/60 px-5 py-2.5">
        <p className="text-[10px] text-slate-500">
          {events.length} event{events.length === 1 ? '' : 's'} · durable (no TTL) · refresh-proof via backlog replay
        </p>
      </footer>
    </section>
  );
}
