/**
 * WalletBadge — live agent wallet readout (balance + status + guardrail note).
 * Refetches on the uiStore walletEpoch bump (after every chat turn) and on a
 * 10s poll. Reads go through the Next.js proxy -> agent-service.
 *
 * v2: authed sessions read their OWN room wallet (/api/agent/wallet/me); the
 * legacy path (onyx-agent) remains for un-authed demos.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useChat } from '@/context/ChatContext';
import { useAuth } from '@/context/AuthContext';
import { useUiStore } from '@/store/auditStore';
import { getJson, formatInr, readJwt } from '@/lib/apiClient';
import type { Wallet } from '@razor-mcp/shared-types';

interface WalletResponse extends Partial<Wallet> {
  error?: string;
}

export default function WalletBadge() {
  const { agentId } = useChat();
  const { user } = useAuth();
  const walletEpoch = useUiStore((s) => s.walletEpoch);
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      // Authed: own-room wallet (JWT attached automatically by apiClient).
      const res = readJwt()
        ? await getJson<WalletResponse>('/api/agent/wallet/me')
        : await getJson<WalletResponse>(`/api/agent/wallet/${encodeURIComponent(agentId)}`);
      setWallet(res);
      setUnreachable(false);
    } catch {
      setUnreachable(true);
    }
  }, [agentId]);

  useEffect(() => {
    void refresh();
  }, [refresh, walletEpoch, user]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (unreachable || !wallet || wallet.error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3.5 py-2 text-xs text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
        <span className="font-mono">{agentId}</span>
        <span className="text-slate-600">· wallet unavailable</span>
      </div>
    );
  }

  const active = wallet.status === 'active';

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3.5 py-2" title="Delegated agent wallet (UPI reserve simulation)">
      <div className="flex flex-col leading-tight">
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{agentId}</span>
        <span className="text-sm font-bold tabular-nums text-slate-100">{formatInr(wallet.balancePaise)}</span>
      </div>
      <span
        className={`rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-widest ${
          active ? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-600/40 bg-rose-500/10 text-rose-300'
        }`}
      >
        {String(wallet.status ?? 'unknown').toUpperCase()}
      </span>
      <span className="hidden text-[10px] text-slate-500 sm:inline">
        auto ≤ {formatInr(500_000)} · OTP above
      </span>
    </div>
  );
}
