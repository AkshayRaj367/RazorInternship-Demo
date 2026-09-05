/**
 * LoginScreen — the auth gate: HUMAN vs AGENT account creation.
 *
 * Human:  email + password -> 6-digit email code -> console. Purchase OTPs
 *         arrive at the registered inbox.
 * Agent:  email + password -> MCP API key revealed ONCE (rzak_...) with the
 *         exact curl for the MCP endpoint. OTPs for agents are delivered
 *         inline in the transaction response.
 *
 * Both account types start with ₹50,000 sandbox (fake) funds; Razorpay BYOK
 * can be connected later from Settings.
 */
'use client';

import { useState } from 'react';
import { useAuth, type RegisterResponse } from '@/context/AuthContext';

type Mode = 'login' | 'register';
type AccountType = 'human' | 'agent';

export default function LoginScreen() {
  const { login, register, verifyEmail } = useAuth();
  const [mode, setMode] = useState<Mode>('register');
  const [accountType, setAccountType] = useState<AccountType>('human');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // post-registration states
  const [awaitingCode, setAwaitingCode] = useState<{ email: string; devCode?: string; sent: boolean } | null>(null);
  const [code, setCode] = useState('');
  const [mcpKeyPanel, setMcpKeyPanel] = useState<RegisterResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        const res = await register(email.trim(), password, accountType, displayName.trim() || undefined);
        if (res.error) {
          setError(res.message || res.error);
        } else if (res.mcpKey) {
          setMcpKeyPanel(res);
        } else if (res.verification?.required) {
          setAwaitingCode({
            email: email.trim(),
            devCode: res.verification.devCode,
            sent: res.verification.emailSent,
          });
        }
      } else {
        const res = await login(email.trim(), password);
        if (res.error) setError(res.message || res.error);
        else if (res.verification?.required)
          setAwaitingCode({
            email: email.trim(),
            devCode: res.verification.devCode,
            sent: res.verification.emailSent,
          });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !awaitingCode || code.trim().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await verifyEmail(awaitingCode.email, code.trim());
      if (res.error) setError(res.message || res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!mcpKeyPanel?.mcpKey) return;
    try {
      await navigator.clipboard.writeText(mcpKeyPanel.mcpKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  // ---------- agent key reveal ----------
  if (mcpKeyPanel?.mcpKey) {
    const curl = [
      `curl -X POST http://localhost:4000/mcp \\`,
      `  -H "X-API-Key: ${mcpKeyPanel.mcpKey}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ].join('\n');
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
        <div className="w-full max-w-lg rounded-2xl border border-emerald-600/50 bg-slate-900 p-6 shadow-2xl">
          <p className="text-[11px] font-bold tracking-widest text-emerald-400">AGENT ACCOUNT CREATED</p>
          <h2 className="mt-1 text-xl font-bold text-slate-100">Your MCP key — shown once</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            This key authenticates JSON-RPC 2.0 calls directly against the MCP server, scoped to YOUR room:
            orders, wallets and audit trails are isolated to this account.
          </p>
          <button
            type="button"
            onClick={() => void copyKey()}
            className="mt-4 w-full rounded-xl border border-emerald-600/40 bg-emerald-500/10 px-4 py-3 font-mono text-sm break-all text-emerald-300 transition hover:bg-emerald-500/20"
          >
            {mcpKeyPanel.mcpKey}
            <span className="ml-2 text-[10px] uppercase tracking-widest">{copied ? 'copied ✓' : 'click to copy'}</span>
          </button>
          <pre className="razor-scroll mt-3 overflow-x-auto rounded-xl border border-slate-700 bg-slate-950/80 p-3 text-[11px] leading-relaxed text-slate-400">
            {curl}
          </pre>
          <p className="mt-3 text-[11px] text-slate-500">
            Tools: search_catalog · web_search · web_product_search (live web + images) · get_item · create_order ·
            get_order_status. OTPs for above-limit purchases are delivered inline in the tool response — verify them
            with the verify-otp endpoint or ask Onyx in chat.
          </p>
          <button
            type="button"
            onClick={() => setMcpKeyPanel(null)}
            className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500"
          >
            Continue to console →
          </button>
        </div>
      </div>
    );
  }

  // ---------- email code verification ----------
  if (awaitingCode) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
        <form onSubmit={submitCode} className="w-full max-w-md rounded-2xl border border-slate-700/60 bg-slate-900 p-6 shadow-2xl">
          <p className="text-[11px] font-bold tracking-widest text-emerald-400">VERIFY YOUR EMAIL</p>
          <h2 className="mt-1 text-xl font-bold text-slate-100">Enter the 6-digit code</h2>
          <p className="mt-2 text-sm text-slate-400">
            {awaitingCode.sent
              ? `Sent to ${awaitingCode.email}. It expires in 10 minutes.`
              : 'SMTP is not configured on this deployment — the code is shown below (DEV_MODE).'}
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            placeholder="6-digit code"
            className="mt-5 w-full rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3 text-center font-mono text-xl tracking-[0.5em] text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/70 focus:outline-none"
          />
          {awaitingCode.devCode && (
            <p className="mt-3 rounded-lg border border-dashed border-emerald-600/50 bg-emerald-500/5 px-3 py-2 text-center text-[11px] text-emerald-300/90">
              DEV_MODE: your code is <span className="font-mono font-bold">{awaitingCode.devCode}</span>
            </p>
          )}
          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
          <button
            type="submit"
            disabled={code.trim().length !== 6 || busy}
            className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? 'Verifying…' : 'Verify & enter console'}
          </button>
          <button
            type="button"
            onClick={() => setAwaitingCode(null)}
            className="mt-2 w-full rounded-xl border border-slate-700 px-4 py-2.5 text-xs text-slate-400 transition hover:bg-slate-800"
          >
            back
          </button>
        </form>
      </div>
    );
  }

  // ---------- login / register ----------
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/15 font-mono text-sm font-black text-emerald-400">
            RZ
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-100">
              Razor-MCP <span className="font-normal text-slate-500">Realtime</span>
            </h1>
            <p className="text-[11px] text-slate-500">live-web products · sandbox funds · isolated rooms</p>
          </div>
        </div>

        <form onSubmit={submit} className="rounded-2xl border border-slate-700/60 bg-slate-900 p-6 shadow-2xl">
          {/* mode tabs */}
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-700 bg-slate-950/70 p-1">
            {(['register', 'login'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError(null); }}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                  mode === m ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {m === 'register' ? 'Create account' : 'Log in'}
              </button>
            ))}
          </div>

          {/* human vs agent — only on register */}
          {mode === 'register' && (
            <div className="mt-4">
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                Are you a human or an agent?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAccountType('human')}
                  className={`rounded-xl border px-3 py-3 text-left transition ${
                    accountType === 'human'
                      ? 'border-emerald-500/70 bg-emerald-500/10'
                      : 'border-slate-700 bg-slate-800/40 hover:border-slate-600'
                  }`}
                >
                  <span className="text-sm font-semibold text-slate-100">👤 Human</span>
                  <span className="mt-1 block text-[10px] leading-snug text-slate-400">
                    Email-verified. Purchase OTPs go to your inbox.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setAccountType('agent')}
                  className={`rounded-xl border px-3 py-3 text-left transition ${
                    accountType === 'agent'
                      ? 'border-sky-500/70 bg-sky-500/10'
                      : 'border-slate-700 bg-slate-800/40 hover:border-slate-600'
                  }`}
                >
                  <span className="text-sm font-semibold text-slate-100">🤖 Agent / MCP</span>
                  <span className="mt-1 block text-[10px] leading-snug text-slate-400">
                    Gets an X-API-Key for the MCP endpoint. OTPs delivered inline.
                  </span>
                </button>
              </div>
            </div>
          )}

          <label className="mt-4 block text-[11px] font-semibold uppercase tracking-widest text-slate-500">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
          />

          <label className="mt-3 block text-[11px] font-semibold uppercase tracking-widest text-slate-500">
            Password {mode === 'register' && <span className="font-normal normal-case text-slate-600">(min 8 chars)</span>}
          </label>
          <input
            type="password"
            required
            minLength={mode === 'register' ? 8 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
          />

          {mode === 'register' && (
            <>
              <label className="mt-3 block text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                Display name <span className="font-normal normal-case text-slate-600">(optional)</span>
              </label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={email.split('@')[0] || 'Onyx operator'}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
              />
            </>
          )}

          {error && (
            <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy || !email.includes('@') || password.length < (mode === 'register' ? 8 : 1)}
            className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy
              ? 'Working…'
              : mode === 'register'
                ? accountType === 'human'
                  ? 'Create human account'
                  : 'Create agent account & issue MCP key'
                : 'Log in'}
          </button>

          <p className="mt-4 text-center text-[10px] leading-relaxed text-slate-600">
            New accounts start with ₹50,000 sandbox funds (fake money). Connect your own Razorpay TEST keys
            later from Settings. Razorpay TEST MODE only — no real funds ever move.
          </p>
        </form>
      </div>
    </div>
  );
}
