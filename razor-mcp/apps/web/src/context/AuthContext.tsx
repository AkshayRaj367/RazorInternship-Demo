/**
 * AuthContext — the login system's client brain.
 *
 * States: 'booting' -> 'loggedOut' | 'verifying' | 'loggedIn'
 *  * Human flow:  register -> (email OTP code) -> verify -> loggedIn
 *  * Agent flow:  register -> mcpKey shown ONCE -> loggedIn
 *  * Login:       email + password -> loggedIn (or re-verify step)
 *
 * The JWT lives in localStorage ('razor.jwt') and is attached to every API
 * call by apiClient. 'razor:unauthorized' (401 anywhere) force-logs-out.
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getJson, postJson, readJwt, writeJwt, formatInr } from '@/lib/apiClient';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  accountType: 'human' | 'agent';
  emailVerified: boolean;
  room: string;
  razorpay: { mode: 'fake' | 'byok'; keyId: string | null };
  mcpKeyMasked: string | null;
  createdAt: string | null;
}

export interface AuthWallet {
  agentId: string;
  balancePaise: number;
  status: string;
}

interface MeResponse {
  user: AuthUser;
  wallet: AuthWallet | null;
  walletAgentId: string;
  spendLimitPaise: number;
  fakeFunds: boolean;
  agentOtpMode?: string;
  smtpConfigured?: boolean;
}

export interface RegisterResponse {
  user?: AuthUser;
  accountType?: string;
  mcpKey?: string;
  mcp?: { endpoint: string; transport: string; header: string; note: string };
  verification?: { required: boolean; emailSent: boolean; delivery: string; devCode?: string };
  error?: string;
  message?: string;
}

export interface LoginResponse {
  token?: string;
  user?: AuthUser;
  verification?: { required: boolean; emailSent: boolean; delivery: string; devCode?: string };
  error?: string;
  message?: string;
}

interface AuthContextValue {
  status: 'booting' | 'loggedOut' | 'verifying' | 'loggedIn';
  user: AuthUser | null;
  wallet: AuthWallet | null;
  spendLimitPaise: number;
  fakeFunds: boolean;
  agentOtpMode: string;
  login: (email: string, password: string) => Promise<LoginResponse>;
  register: (email: string, password: string, accountType: 'human' | 'agent', displayName?: string) => Promise<RegisterResponse>;
  verifyEmail: (email: string, code: string) => Promise<LoginResponse>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'booting' | 'loggedOut' | 'verifying' | 'loggedIn'>('booting');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [wallet, setWallet] = useState<AuthWallet | null>(null);
  const [spendLimitPaise, setSpendLimitPaise] = useState(500_000);
  const [fakeFunds, setFakeFunds] = useState(true);
  const [agentOtpMode, setAgentOtpMode] = useState('inline');

  const refresh = useCallback(async () => {
    if (!readJwt()) {
      setStatus('loggedOut');
      setUser(null);
      setWallet(null);
      return;
    }
    try {
      const me = await getJson<MeResponse>('/api/agent/me');
      setUser(me.user);
      setWallet(me.wallet);
      setSpendLimitPaise(me.spendLimitPaise);
      setFakeFunds(me.fakeFunds);
      setAgentOtpMode(me.agentOtpMode ?? 'inline');
      setStatus('loggedIn');
    } catch {
      writeJwt(null);
      setStatus('loggedOut');
      setUser(null);
      setWallet(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => {
      writeJwt(null);
      setStatus('loggedOut');
      setUser(null);
      setWallet(null);
    };
    window.addEventListener('razor:unauthorized', onUnauthorized);
    return () => window.removeEventListener('razor:unauthorized', onUnauthorized);
  }, [refresh]);

  const register = useCallback(
    async (email: string, password: string, accountType: 'human' | 'agent', displayName?: string) => {
      const res = await postJson<RegisterResponse>('/api/agent/auth/register', {
        email,
        password,
        accountType,
        displayName,
      });
      if (res.verification?.required) setStatus('verifying');
      return res;
    },
    []
  );

  const login = useCallback(async (email: string, password: string) => {
    const res = await postJson<LoginResponse>('/api/agent/auth/login', { email, password });
    if (res.token) {
      writeJwt(res.token);
      await refresh();
    } else if (res.verification?.required) {
      setStatus('verifying');
    }
    return res;
  }, [refresh]);

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const res = await postJson<LoginResponse>('/api/agent/auth/verify-email', { email, code });
    if (res.token) {
      writeJwt(res.token);
      await refresh();
    }
    return res;
  }, [refresh]);

  const logout = useCallback(() => {
    writeJwt(null);
    setStatus('loggedOut');
    setUser(null);
    setWallet(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      wallet,
      spendLimitPaise,
      fakeFunds,
      agentOtpMode,
      login,
      register,
      verifyEmail,
      logout,
      refresh,
    }),
    [status, user, wallet, spendLimitPaise, fakeFunds, agentOtpMode, login, register, verifyEmail, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Helper for the login screen copy. */
export function walletBalanceLabel(wallet: AuthWallet | null): string {
  return wallet ? formatInr(wallet.balancePaise) : '—';
}
