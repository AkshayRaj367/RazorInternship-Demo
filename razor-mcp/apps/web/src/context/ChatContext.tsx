/**
 * ChatContext — owns sessionId/agentId and the ONE send() function.
 *
 * The OnyxAssistant quick-start pills, the ChatPanel manual input box and the
 * ProductGrid buy buttons all submit through this exact send() — no duplicated
 * chat-submission logic.
 *
 * v2:
 *  * agentId comes from the logged-in room (user:<uid>) when authed; legacy
 *    'onyx-agent' otherwise.
 *  * web_product_search tool results are surfaced as `products` on the message
 *    so ChatPanel can render ProductGrid cards with real images.
 *  * checkout_and_pay results carrying payment.mode='byok' automatically open
 *    the Razorpay checkout modal (checkout.js) and confirm via signature
 *    verification (POST /api/agent/transactions/<id>/confirm-payment).
 */
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { postJson, getJson } from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import { useUiStore } from '@/store/auditStore';
import type { WebProductCard } from '@/components/ProductGrid';

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallRecord[];
  products?: WebProductCard[];
  timestamp: string;
  error?: boolean;
}

export const ONBOARDING_FLAG = 'hasSeenOnboarding';
const SESSION_FLAG = 'razor-mcp-sessionId';
export const DEFAULT_AGENT_ID = 'onyx-agent';

interface ChatContextValue {
  sessionId: string;
  agentId: string;
  messages: ChatMessage[];
  loading: boolean;
  hasSeenOnboarding: boolean;
  markOnboardingSeen: () => void;
  send: (message: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);

interface ChatApiResponse {
  reply: string;
  toolCalls?: ToolCallRecord[];
  sessionId: string;
  agentId: string;
}

interface HistoryResponse {
  messages: Array<{ role: string; content: string; timestamp?: string; toolName?: string }>;
}

function readSessionId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.localStorage.getItem(SESSION_FLAG);
    if (existing && /^[A-Za-z0-9._:-]{6,128}$/.test(existing)) return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(SESSION_FLAG, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** Extract purchasable web products from a web_product_search tool result. */
function productsFromToolCalls(toolCalls?: ToolCallRecord[]): WebProductCard[] {
  const out: WebProductCard[] = [];
  for (const tc of toolCalls ?? []) {
    if (tc.name !== 'web_product_search') continue;
    const products = (tc.result as { products?: unknown }).products;
    if (!Array.isArray(products)) continue;
    for (const p of products) {
      const c = p as Partial<WebProductCard>;
      if (typeof c.webId === 'string' && typeof c.name === 'string') {
        out.push({
          webId: c.webId,
          name: c.name,
          pricePaise: typeof c.pricePaise === 'number' ? c.pricePaise : null,
          priceText: typeof c.priceText === 'string' ? c.priceText : null,
          source: typeof c.source === 'string' ? c.source : 'web',
          url: typeof c.url === 'string' ? c.url : '#',
          image: typeof c.image === 'string' ? c.image : '',
        });
      }
    }
  }
  return out;
}

/** Open the Razorpay checkout modal for a BYOK transaction and confirm it. */
async function runRazorpayCheckout(
  payment: { checkoutKey: string; razorpayOrderId: string; amountPaise: number },
  transactionId: string,
  displayName: string
): Promise<boolean> {
  const w = window as unknown as { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void } };
  if (!w.Razorpay) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('checkout.js failed to load'));
      document.head.appendChild(s);
    });
  }
  const RazorpayCtor = (window as unknown as { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void } }).Razorpay;
  if (!RazorpayCtor) throw new Error('Razorpay checkout unavailable');

  return new Promise<boolean>((resolve) => {
    const rzp = new RazorpayCtor({
      key: payment.checkoutKey, // the user's own TEST key_id (public by design)
      amount: payment.amountPaise,
      currency: 'INR',
      name: 'Razor-MCP (BYOK TEST)',
      description: `Order ${payment.razorpayOrderId}`,
      order_id: payment.razorpayOrderId,
      prefill: { name: displayName },
      theme: { color: '#10b981' },
      handler: async (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        try {
          await postJson(`/api/agent/transactions/${encodeURIComponent(transactionId)}/confirm-payment`, {
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
          });
          resolve(true);
        } catch {
          resolve(false);
        }
      },
      modal: {
        ondismiss: () => resolve(false),
      },
    });
    rzp.open();
  });
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { user, status: authStatus, refresh } = useAuth();
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(true); // server-safe default
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    const sid = readSessionId();
    setSessionId(sid);
    try {
      setHasSeenOnboarding(window.localStorage.getItem(ONBOARDING_FLAG) === 'true');
    } catch {
      setHasSeenOnboarding(false);
    }
    // Refresh-proof chat: restore the capped, isolated history for this session.
    getJson<HistoryResponse>(`/api/agent/conversation/${encodeURIComponent(sid)}`)
      .then((res) => {
        const restored: ChatMessage[] = (res.messages ?? [])
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m, i) => ({
            id: `hist-${i}`,
            role: m.role as 'user' | 'assistant',
            content: m.content ?? '',
            timestamp: m.timestamp ?? new Date().toISOString(),
          }));
        if (restored.length > 0) setMessages(restored);
      })
      .catch(() => undefined);
  }, []);

  const markOnboardingSeen = useCallback(() => {
    setHasSeenOnboarding(true);
    try {
      window.localStorage.setItem(ONBOARDING_FLAG, 'true');
    } catch {
      /* private mode */
    }
  }, []);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || loading || !sessionId) return;
      markOnboardingSeen(); // first message sent -> onboarding is done

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      try {
        const res = await postJson<ChatApiResponse>('/api/agent/chat', {
          prompt: trimmed,
          sessionId,
          agentId: user ? user.room : DEFAULT_AGENT_ID,
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: res.reply ?? '(empty reply)',
            toolCalls: res.toolCalls ?? [],
            products: productsFromToolCalls(res.toolCalls),
            timestamp: new Date().toISOString(),
          },
        ]);

        // BYOK checkout: if a checkout_and_pay result carries a Razorpay
        // payment payload, open the modal and confirm the signature server-side.
        for (const tc of res.toolCalls ?? []) {
          const payment = (tc.result as { payment?: { mode?: string; checkoutKey?: string; razorpayOrderId?: string; amountPaise?: number } }).payment;
          const txId = typeof (tc.result as { transactionId?: unknown }).transactionId === 'string'
            ? (tc.result as { transactionId: string }).transactionId
            : null;
          if (payment?.mode === 'byok' && payment.checkoutKey && payment.razorpayOrderId && txId) {
            try {
              const paid = await runRazorpayCheckout(
                { checkoutKey: payment.checkoutKey, razorpayOrderId: payment.razorpayOrderId, amountPaise: payment.amountPaise ?? 0 },
                txId,
                user?.displayName ?? 'Onyx operator'
              );
              if (paid) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: `a-pay-${Date.now()}`,
                    role: 'assistant',
                    content: '✅ Razorpay TEST payment verified and captured (signature check passed).',
                    timestamp: new Date().toISOString(),
                  },
                ]);
              }
            } catch {
              /* modal failed/dismissed — the timeline already shows awaiting_payment */
            }
            void refresh();
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'chat request failed';
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: `I couldn't reach the agent-service (${msg}). The audit trail below still shows any recorded intent.`,
            timestamp: new Date().toISOString(),
            error: true,
          },
        ]);
      } finally {
        setLoading(false);
        useUiStore.getState().bumpWallet(); // refresh the badge after any spend
      }
    },
    [loading, sessionId, markOnboardingSeen, user, refresh]
  );

  const agentId = user?.room ?? DEFAULT_AGENT_ID;
  const chatEnabled = authStatus === 'loggedIn' || authStatus === 'booting';

  const value = useMemo<ChatContextValue>(
    () => ({ sessionId, agentId, messages, loading: loading || !chatEnabled, hasSeenOnboarding, markOnboardingSeen, send }),
    [sessionId, agentId, messages, loading, chatEnabled, hasSeenOnboarding, markOnboardingSeen, send]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used inside <ChatProvider>');
  return ctx;
}
