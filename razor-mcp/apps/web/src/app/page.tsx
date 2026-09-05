/**
 * Razor-MCP Console — auth-gated split view: Onyx chat (left) + live RazorSense
 * audit dashboard (right), with the OTP gate, BYOK settings and recovery banner
 * as overlays. Logged-out visitors see the LoginScreen (human vs agent).
 */
'use client';

import { useEffect, useState } from 'react';
import ChatPanel from '@/components/ChatPanel';
import AuditTimeline from '@/components/AuditTimeline';
import WalletBadge from '@/components/WalletBadge';
import OTPModal from '@/components/OTPModal';
import RecoveryBanner from '@/components/RecoveryBanner';
import LoginScreen from '@/components/LoginScreen';
import SettingsPanel from '@/components/SettingsPanel';
import { useChat } from '@/context/ChatContext';
import { useAuth } from '@/context/AuthContext';
import { useSocket } from '@/hooks/useSocket';
import { useAuditStore } from '@/store/auditStore';

export default function Home() {
  const { sessionId } = useChat();
  const { status: authStatus, user, fakeFunds } = useAuth();
  const setAuditSession = useAuditStore((s) => s.setSession);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const socketStatus = useSocket(sessionId || null);

  // Bind the audit store to the active session (localStorage key switch).
  useEffect(() => {
    if (sessionId) setAuditSession(sessionId);
  }, [sessionId, setAuditSession]);

  if (authStatus === 'booting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-sm">waking the rails…</span>
        </div>
      </div>
    );
  }

  if (authStatus !== 'loggedIn') {
    return <LoginScreen />;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <RecoveryBanner />

      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 font-mono text-sm font-black text-emerald-400">
              RZ
            </div>
            <div className="leading-tight">
              <h1 className="text-base font-bold tracking-tight text-slate-100">
                Razor-MCP <span className="font-normal text-slate-500">Realtime Console</span>
              </h1>
              <p className="text-[11px] text-slate-500">
                live-web products · <span className="text-emerald-400/90">fake funds sandbox</span>
                {!fakeFunds && <> · <span className="text-amber-400/90">Razorpay BYOK</span></>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {sessionId && (
              <span
                className="hidden max-w-[160px] truncate rounded-lg border border-slate-700/70 bg-slate-900/80 px-2.5 py-1.5 font-mono text-[10px] text-slate-500 md:inline-block"
                title={sessionId}
              >
                session {sessionId.slice(0, 13)}…
              </span>
            )}
            <WalletBadge />
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Account settings"
              title="Account settings — payment mode, MCP key"
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700/70 bg-slate-900/80 text-sm text-slate-400 transition hover:border-emerald-500/50 hover:text-emerald-300"
            >
              ⚙
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <ChatPanel />
          <AuditTimeline status={socketStatus} />
        </div>
      </main>

      <footer className="border-t border-slate-800/80 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
          <span>
            {user?.accountType === 'agent' ? '🤖 agent room' : '👤 human room'} · guardrail enforcement:{' '}
            <span className="font-mono text-slate-500">wallet_service.py</span> (atomic OCC debit)
          </span>
          <span>real-time web search · idempotent transactions · TTL-bounded recovery · capped chat memory</span>
        </div>
      </footer>

      <OTPModal />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
