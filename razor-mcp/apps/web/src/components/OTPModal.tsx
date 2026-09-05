/**
 * OTPModal — the human approval gate (appears on GUARDRAIL_OTP_REQUIRED /
 * the dedicated 'otp:required' socket event).
 *
 * Posts the human-entered OTP through the Next.js proxy to
 * POST /api/agent/transactions/<id>/verify-otp — the server-side verify that
 * atomically consumes a bcrypt-hashed challenge and only then executes the
 * OTP-authorized debit.
 */
'use client';

import { useEffect, useState } from 'react';
import { useAuditStore, useUiStore } from '@/store/auditStore';
import { postJson, formatInr } from '@/lib/apiClient';
import { AuditStepEnum } from '@razor-mcp/shared-types';

interface VerifyResponse {
  status?: string;
  message?: string;
  attemptsLeft?: number;
  failureReason?: string;
}

export default function OTPModal() {
  const otpRequired = useUiStore((s) => s.otpRequired);
  const clearOtp = useUiStore((s) => s.setOtpRequired);
  const sessionId = useAuditStore((s) => s.sessionId);
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);

  // Also open when a GUARDRAIL_OTP_REQUIRED audit step arrives without the
  // dedicated event (belt and braces) — the otp:required event carries the ids.
  useEffect(() => {
    if (!otpRequired) {
      setOtp('');
      setFeedback(null);
    }
  }, [otpRequired]);

  if (!otpRequired) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (otp.trim().length !== 6 || submitting) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await postJson<VerifyResponse>(
        `/api/agent/transactions/${encodeURIComponent(otpRequired.transactionId)}/verify-otp`,
        { otp: otp.trim(), sessionId: sessionId ?? otpRequired.sessionId }
      );
      if (res.status === 'pending' || res.status === 'completed') {
        setFeedback({ tone: 'success', text: 'Approved — payment executed. Watch the timeline.' });
        setTimeout(() => clearOtp(null), 1600);
      } else if (res.status === 'awaiting_otp') {
        setFeedback({
          tone: 'error',
          text: `Incorrect OTP — ${res.attemptsLeft ?? '?'} attempt(s) left before rejection.`,
        });
      } else {
        setFeedback({ tone: 'error', text: res.message ?? `Transaction ${res.status}.` });
        setTimeout(() => clearOtp(null), 2200);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'verify failed';
      setFeedback({ tone: 'error', text: msg });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="OTP verification required"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-amber-600/50 bg-slate-900 p-6 shadow-2xl shadow-black/50 animate-fade-in-up"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-widest text-amber-400">HUMAN APPROVAL REQUIRED</p>
            <h3 className="mt-1 text-lg font-bold text-slate-100">Verify OTP to authorize payment</h3>
          </div>
          <span className="rounded-full border border-amber-600/40 bg-amber-500/10 px-2.5 py-1 text-[10px] font-bold tracking-widest text-amber-300">
            GUARDRAIL
          </span>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-slate-300">
          Onyx wants to spend{' '}
          <span className="font-bold tabular-nums text-amber-300">{formatInr(otpRequired.amountPaise)}</span>
          {otpRequired.orderNumber ? (
            <>
              {' '}on order <span className="font-mono text-xs text-slate-400">{otpRequired.orderNumber}</span>
            </>
          ) : null}
          . That is above the ₹5,000 autonomous limit, so a human must approve it. The wallet has
          NOT been touched yet.
        </p>

        <input
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="6-digit OTP"
          aria-label="6-digit OTP"
          className="mt-5 w-full rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3 text-center font-mono text-xl tracking-[0.5em] text-slate-100 placeholder:text-slate-600 focus:border-amber-500/70 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
        />

        {feedback && (
          <p
            className={`mt-3 text-sm ${
              feedback.tone === 'success'
                ? 'text-emerald-300'
                : feedback.tone === 'error'
                  ? 'text-rose-300'
                  : 'text-slate-300'
            }`}
          >
            {feedback.text}
          </p>
        )}

        {typeof otpRequired.devOtp === 'string' && otpRequired.devOtp.length > 0 && (
          <button
            type="button"
            onClick={() => setOtp(otpRequired.devOtp ?? '')}
            className="mt-3 w-full rounded-lg border border-dashed border-amber-600/50 bg-amber-500/5 px-3 py-2 text-center text-[11px] text-amber-300/90 transition hover:bg-amber-500/10"
          >
            DEV_MODE: OTP is returned in the API response in dev — click to fill{' '}
            <span className="font-mono font-bold">{otpRequired.devOtp}</span> (production sends it via SMS/push)
          </button>
        )}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => clearOtp(null)}
            className="flex-1 rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-300 transition hover:bg-slate-800"
          >
            Decline
          </button>
          <button
            type="submit"
            disabled={otp.trim().length !== 6 || submitting}
            className="flex-[2] rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Verifying…' : 'Authorize payment'}
          </button>
        </div>

        <p className="mt-4 text-[10px] leading-relaxed text-slate-500">
          3 wrong attempts reject the transaction and release the reserved stock. The challenge
          expires after 5 minutes. Audit step: {AuditStepEnum.OTP_VERIFIED} lands only after the
          server verifies the bcrypt hash.
        </p>
      </form>
    </div>
  );
}
