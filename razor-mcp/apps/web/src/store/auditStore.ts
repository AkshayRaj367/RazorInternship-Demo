/**
 * RazorSense audit trail store.
 *
 * Persistence contract (refresh-proof timeline):
 *   - zustand + persist, keyed BY SESSION ID: the custom storage below prefixes
 *     every key with the active sessionId, so each session hydrates its own
 *     timeline from localStorage (instant paint on refresh).
 *   - On socket (re)join, ws-gateway replays the full server backlog
 *     (audit:backlog). reconcileBacklog() merges by Mongo _id with
 *     SERVER-WINS semantics on conflicts — localStorage is only ever a cache.
 */
'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuditLogEntry, OtpRequiredPayload, RecoveryLinkPayload } from '@razor-mcp/shared-types';

// ---------------------------------------------------------------------------
// Per-session keyed localStorage bridge
// ---------------------------------------------------------------------------

let activeSessionId = 'default';

const sessionKeyedStorage = {
  getItem: (name: string): string | null => {
    try {
      return window.localStorage.getItem(`razor-mcp-audit:${activeSessionId}:${name}`);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      window.localStorage.setItem(`razor-mcp-audit:${activeSessionId}:${name}`, value);
    } catch {
      /* quota/private-mode: persistence is best-effort */
    }
  },
  removeItem: (name: string): void => {
    try {
      window.localStorage.removeItem(`razor-mcp-audit:${activeSessionId}:${name}`);
    } catch {
      /* noop */
    }
  },
};

// ---------------------------------------------------------------------------
// Audit store (persisted)
// ---------------------------------------------------------------------------

interface AuditState {
  sessionId: string;
  events: AuditLogEntry[];
  hydratedAt: string | null;
  setSession: (sessionId: string) => void;
  appendEvent: (entry: AuditLogEntry) => void;
  reconcileBacklog: (events: AuditLogEntry[]) => void;
  clear: () => void;
}

function sortByTimestamp(events: AuditLogEntry[]): AuditLogEntry[] {
  return [...events].sort((a, b) => {
    const ta = a.timestamp ?? '';
    const tb = b.timestamp ?? '';
    if (ta === tb) return (a._id ?? '').localeCompare(b._id ?? '');
    return ta < tb ? -1 : 1;
  });
}

function dedupeById(events: AuditLogEntry[]): AuditLogEntry[] {
  const byId = new Map<string, AuditLogEntry>();
  for (const e of events) {
    byId.set(e._id, e); // later occurrence wins (server backlog is applied last)
  }
  return sortByTimestamp([...byId.values()]);
}

export const useAuditStore = create<AuditState>()(
  persist(
    (set, get) => ({
      sessionId: 'default',
      events: [],
      hydratedAt: null,

      setSession: (sessionId) => {
        if (get().sessionId === sessionId) return;
        activeSessionId = sessionId; // switch the localStorage key namespace
        set({ sessionId, events: [], hydratedAt: null });
        // Rehydrate from this session's localStorage slice (instant paint),
        // then let the socket backlog reconcile server truth on top.
        void useAuditStore.persist.rehydrate();
      },

      appendEvent: (entry) => {
        if (!entry?._id) return;
        set((state) => ({ events: dedupeById([...state.events, entry]) }));
      },

      reconcileBacklog: (events) => {
        // Merge with server-wins semantics: dedupe on _id; on conflict the
        // server entry replaces the cached one; then re-sort by timestamp.
        set((state) => {
          const byId = new Map<string, AuditLogEntry>();
          for (const e of state.events) byId.set(e._id, e);
          for (const e of events ?? []) {
            if (e?._id) byId.set(e._id, e); // server wins
          }
          return { events: sortByTimestamp([...byId.values()]), hydratedAt: new Date().toISOString() };
        });
      },

      clear: () => set({ events: [], hydratedAt: null }),
    }),
    {
      name: 'events',
      storage: createJSONStorage(() => sessionKeyedStorage),
      partialize: (state) => ({ sessionId: state.sessionId, events: state.events }) as AuditState,
    }
  )
);

// ---------------------------------------------------------------------------
// Ephemeral UI state (socket-driven overlays; intentionally NOT persisted)
// ---------------------------------------------------------------------------

interface UiState {
  otpRequired: OtpRequiredPayload | null;
  recoveryLink: RecoveryLinkPayload | null;
  walletEpoch: number; // bump to make WalletBadge refetch immediately
  setOtpRequired: (payload: OtpRequiredPayload | null) => void;
  setRecoveryLink: (payload: RecoveryLinkPayload | null) => void;
  bumpWallet: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  otpRequired: null,
  recoveryLink: null,
  walletEpoch: 0,
  setOtpRequired: (payload) => set({ otpRequired: payload }),
  setRecoveryLink: (payload) => set({ recoveryLink: payload }),
  bumpWallet: () => set((s) => ({ walletEpoch: s.walletEpoch + 1 })),
}));
