/**
 * SettingsPanel — account + payment settings modal.
 *
 *  * Account summary (room, account type, masked MCP key for agents)
 *  * Payment mode: SANDBOX FAKE FUNDS (default) vs BYOK Razorpay (paste your
 *    own rzp_test_ keys — stored Fernet-encrypted server-side; the secret
 *    never returns to the browser). BYOK checkouts open the real Razorpay TEST
 *    modal and are confirmed by signature verification.
 *  * Agents can regenerate their MCP key.
 */
'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { postJson, formatInr } from '@/lib/apiClient';
import { useUiStore } from '@/store/auditStore';

export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, wallet, fakeFunds, refresh, logout } = useAuth();
  const bumpWallet = useUiStore((s) => s.bumpWallet);
  const [mode, setMode] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [newMcpKey, setNewMcpKey] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode('idle');
      setError(null);
      setNewMcpKey(null);
      setKeyId(user?.razorpay.keyId ?? '');
      setKeySecret('');
    }
  }, [open, user]);

  if (!open || !user) return null;

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'saving') return;
    setMode('saving');
    setError(null);
    try {
      await postJson('/api/agent/auth/razorpay', { keyId: keyId.trim(), keySecret: keySecret.trim() });
      setMode('saved');
      setKeySecret('');
      await refresh();
      bumpWallet();
      setTimeout(() => setMode('idle'), 1800);
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'failed to connect');
    }
  };

  const disconnect = async () => {
    if (mode === 'saving') return;
    setMode('saving');
    try {
      await postJson('/api/agent/auth/razorpay/disconnect', {});
      await refresh();
      bumpWallet();
      setMode('idle');
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'failed to disconnect');
    }
  };

  const regenerate = async () => {
    if (mode === 'saving') return;
    setMode('saving');
    try {
      const res = await postJson<{ mcpKey?: string; message?: string; error?: string }>('/api/agent/auth/regenerate-key', {});
      if (res.mcpKey) setNewMcpKey(res.mcpKey);
      else if (res.message) setError(res.message);
      setMode('idle');
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'failed');
      setMode('idle');
    }
  };

  const isByok = user.razorpay.mode === 'byok';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Account settings"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    >
      <div className="razor-scroll max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-widest text-emerald-400">ACCOUNT SETTINGS</p>
            <h2 className="mt-1 text-lg font-bold text-slate-100">{user.displayName}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200">
            ✕
          </button>
        </div>

        {/* account summary */}
        <div className="mt-4 space-y-1.5 rounded-xl border border-slate-700/70 bg-slate-950/50 p-3.5 text-xs text-slate-400">
          <p><span className="text-slate-500">email:</span> {user.email}</p>
          <p><span className="text-slate-500">account:</span> {user.accountType === 'agent' ? '🤖 agent (MCP)' : '👤 human'}</p>
          <p className="font-mono"><span className="text-slate-500">room:</span> {user.room}</p>
          {wallet && (
            <p><span className="text-slate-500">sandbox wallet:</span> <span className="font-bold text-emerald-300">{formatInr(wallet.balancePaise)}</span></p>
          )}
          {user.accountType === 'agent' && user.mcpKeyMasked && (
            <p className="font-mono"><span className="text-slate-500">mcp key:</span> {user.mcpKeyMasked}</p>
          )}
        </div>

        {/* payment mode */}
        <p className="mt-5 text-[11px] font-bold uppercase tracking-widest text-slate-500">Payment mode</p>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className={`rounded-xl border p-3 ${!isByok ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-slate-700 bg-slate-800/40'}`}>
            <p className="text-xs font-semibold text-slate-100">Fake funds (sandbox)</p>
            <p className="mt-1 text-[10px] leading-snug text-slate-400">
              Wallet balance is simulated. Purchases debit sandbox funds — no Razorpay account needed.
            </p>
            {!isByok && <p className="mt-2 text-[10px] font-bold text-emerald-300">● ACTIVE</p>}
          </div>
          <div className={`rounded-xl border p-3 ${isByok ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-700 bg-slate-800/40'}`}>
            <p className="text-xs font-semibold text-slate-100">Razorpay BYOK</p>
            <p className="mt-1 text-[10px] leading-snug text-slate-400">
              Bring your own TEST keys — checkouts open the real Razorpay TEST modal (signature-verified).
            </p>
            {isByok && <p className="mt-2 text-[10px] font-bold text-amber-300">● CONNECTED {user.razorpay.keyId?.slice(0, 16)}…</p>}
          </div>
        </div>

        {isByok ? (
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={mode === 'saving'}
            className="mt-3 w-full rounded-xl border border-slate-600 px-4 py-2.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            Disconnect Razorpay → back to fake funds
          </button>
        ) : (
          <form onSubmit={connect} className="mt-3 space-y-2.5">
            <input
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              placeholder="rzp_test_XXXXXXXXXXXXXX (TEST keys only)"
              className="w-full rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-amber-500/60 focus:outline-none"
            />
            <input
              type="password"
              value={keySecret}
              onChange={(e) => setKeySecret(e.target.value)}
              placeholder="key_secret (encrypted at rest — never shown again)"
              className="w-full rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-amber-500/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={mode === 'saving' || !keyId.startsWith('rzp_test_') || keySecret.length < 8}
              className="w-full rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {mode === 'saving' ? 'Connecting…' : mode === 'saved' ? 'Connected ✓' : 'Connect Razorpay TEST keys'}
            </button>
            <p className="text-[10px] leading-relaxed text-slate-500">
              TEST MODE only. Dashboard → Settings → API Keys → Test. Keys are Fernet-encrypted server-side; the key_id
              (public) powers the checkout modal, the secret verifies payment signatures.
            </p>
          </form>
        )}

        {error && <p className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}

        {/* agent key regeneration */}
        {user.accountType === 'agent' && (
          <>
            <p className="mt-5 text-[11px] font-bold uppercase tracking-widest text-slate-500">MCP access</p>
            <button
              type="button"
              onClick={() => void regenerate()}
              disabled={mode === 'saving'}
              className="mt-2 w-full rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-40"
            >
              Regenerate MCP key
            </button>
            {newMcpKey && (
              <p className="mt-2 break-all rounded-lg border border-sky-500/40 bg-slate-950/70 px-3 py-2 font-mono text-[11px] text-sky-300">
                {newMcpKey} <span className="text-slate-500">— store it now, shown once</span>
              </p>
            )}
          </>
        )}

        <button
          type="button"
          onClick={() => { logout(); onClose(); }}
          className="mt-6 w-full rounded-xl border border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-rose-300"
        >
          Log out
        </button>
      </div>
    </div>
  );
}
