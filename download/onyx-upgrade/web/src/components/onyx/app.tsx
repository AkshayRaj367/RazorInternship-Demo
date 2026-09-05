"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, LayoutGrid, Megaphone, BarChart3, ScrollText, Bell, Zap, Smartphone, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChatPanel, type ChatMessage } from "./chat";
import { WalletRail, CatalogPanel, CampaignsPanel, InsightsPanel, AuditPanel, type AuditItem } from "./panels";
import { Card, fmt, StatusChip } from "./shared";
import type { AgentResponse, WalletView } from "@/lib/agent/types";
import { cn } from "@/lib/utils";

type Tab = "chat" | "catalog" | "campaigns" | "insights" | "audit";

const NAV: Array<{ id: Tab; label: string; icon: typeof MessageSquare; hint: string }> = [
  { id: "chat", label: "Agent Chat", icon: MessageSquare, hint: "Buy with guardrails" },
  { id: "catalog", label: "Catalog", icon: LayoutGrid, hint: "Agent-readable SKUs" },
  { id: "campaigns", label: "Campaigns", icon: Megaphone, hint: "Growth orchestrator" },
  { id: "insights", label: "Insights", icon: BarChart3, hint: "Merchant dashboard" },
  { id: "audit", label: "Audit Trail", icon: ScrollText, hint: "Every money action" },
];

interface DeviceMsg { id: string; code: string; status: string; expiresAt: string; at: string; from: string; body: string; }

const WELCOME: ChatMessage = {
  role: "assistant",
  text: "Welcome to **Onyx** — your guardrailed shopping agent on Razorpay test mode.\n\nI can search the catalog, buy within policy, escalate OTPs to your registered device, apply live campaigns and grow the merchant's basket with ranked upsells. Every money action is explainable, bounded and audited.\n\nTry **“Buy a premium watch for ₹10,000”** — watch the policy stack decide, live.",
};

export function OnyxApp() {
  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME]);
  const [sending, setSending] = useState(false);
  const [state, setState] = useState<AgentResponse | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [deviceMsgs, setDeviceMsgs] = useState<DeviceMsg[]>([]);
  const [auditFeed, setAuditFeed] = useState<AuditItem[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const stateRef = useRef<AgentResponse | null>(null);
  stateRef.current = state;

  const refreshSide = useCallback(async () => {
    try {
      const [w, d, a] = await Promise.all([
        fetch("/api/wallet").then((r) => r.json()),
        fetch("/api/device").then((r) => r.json()),
        fetch("/api/audit").then((r) => r.json()),
      ]);
      if (w.wallet) setWallet(w.wallet);
      if (d.messages) setDeviceMsgs(d.messages);
      if (a.events) setAuditFeed(a.events);
    } catch { /* transient */ }
  }, []);

  useEffect(() => { refreshSide(); const t = setInterval(refreshSide, 8000); return () => clearInterval(t); }, [refreshSide]);

  const send = useCallback(async (text: string) => {
    setSending(true);
    setMessages((m) => [...m, { role: "user", text }]);
    const prev = stateRef.current;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const d = (await res.json()) as AgentResponse;
      setState(d);
      setWallet(d.wallet);
      setMessages((m) => [...m, { role: "assistant", text: d.assistantText, toolCalls: d.toolCalls }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "I hit a connection error — the agent service didn't respond. Nothing was charged; try again." }]);
    } finally {
      setSending(false);
      refreshSide();
    }
  }, [refreshSide]);

  // Propagate chat messages from other tabs (catalog "buy" / campaign "test")
  const sendAndSwitch = useCallback((text: string) => {
    setTab("chat");
    if (!sending) send(text);
  }, [send, sending]);

  const unread = deviceMsgs.filter((m) => m.status === "PENDING" && new Date(m.expiresAt) > new Date()).length;

  return (
    <div className="flex min-h-screen overflow-x-hidden bg-[#02042B] text-slate-200">
      {/* ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-[#4A6CFF]/10 blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 h-80 w-80 rounded-full bg-[#00C2FF]/[0.07] blur-[120px]" />
      </div>

      {/* sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-[68px] flex-col border-r border-white/10 bg-[#03052E]/95 backdrop-blur lg:w-56">
        <div className="flex h-14 items-center gap-2.5 px-3 lg:px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#00C2FF] to-[#4A6CFF] shadow-lg shadow-[#4A6CFF]/30">
            <Zap className="h-4.5 w-4.5 text-[#02042B]" strokeWidth={2.5} />
          </span>
          <div className="hidden lg:block">
            <p className="text-sm font-bold leading-tight tracking-tight text-white">Onyx</p>
            <p className="text-[9px] uppercase tracking-widest text-slate-500">agentic commerce</p>
          </div>
        </div>

        <nav className="mt-2 flex-1 space-y-1 px-2 lg:px-3">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setTab(n.id)}
              title={n.label}
              className={cn(
                "group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition",
                tab === n.id
                  ? "bg-gradient-to-r from-[#00C2FF]/15 to-[#4A6CFF]/15 text-white shadow-inner"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              )}
            >
              <n.icon className={cn("h-4.5 w-4.5 shrink-0", tab === n.id && "text-[#7DD3FC]")} />
              <span className="hidden text-[13px] font-medium lg:block">{n.label}</span>
              {tab === n.id && <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-[#00C2FF] lg:block" />
              }
            </button>
          ))}
        </nav>

        <div className="hidden space-y-2 px-4 pb-4 lg:block">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
            <p className="text-[9px] uppercase tracking-widest text-slate-500">Test mode</p>
            <p className="text-[11px] font-medium text-emerald-300">Razorpay rzp_test</p>
            <p className="mt-1 text-[9px] text-slate-600">No real money moves</p>
          </div>
        </div>
      </aside>

      {/* main */}
      <div className="relative z-10 ml-[68px] flex min-h-screen w-[calc(100%-68px)] min-w-0 flex-col overflow-x-hidden lg:ml-56 lg:w-[calc(100%-14rem)]">
        {/* header */}
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-white/10 bg-[#03052E]/80 px-4 backdrop-blur sm:px-6">
          <h1 className="text-sm font-semibold text-white">{NAV.find((n) => n.id === tab)?.label}</h1>
          <StatusChip status="ok">guardrailed · audited</StatusChip>

          <div className="ml-auto flex items-center gap-2.5">
            {wallet && (
              <span className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 md:flex">
                <span className="text-[10px] text-slate-500">wallet</span>
                <span className="font-mono text-xs font-semibold text-white">{fmt(wallet.balancePaise)}</span>
                <span className="h-3 w-px bg-white/10" />
                <span className="font-mono text-[10px] text-emerald-300">≤{fmt(wallet.effectiveLimitPaise)} auto</span>
              </span>
            )}

            {/* device simulator */}
            <Popover open={bellOpen} onOpenChange={setBellOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="relative h-9 w-9 rounded-full border-white/15 bg-white/[0.04] hover:bg-white/10">
                  <Bell className="h-4 w-4 text-slate-300" />
                  {unread > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] px-1 text-[9px] font-bold text-[#02042B]">
                      {unread}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 border-white/15 bg-[#0A0E3F] p-0">
                <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                  <Smartphone className="h-3.5 w-3.5 text-[#7DD3FC]" />
                  <p className="text-xs font-semibold text-white">Registered device</p>
                  <span className="font-mono text-[10px] text-slate-500">+91 ••••• 99413</span>
                </div>
                <div className="max-h-64 space-y-2 overflow-y-auto p-3 [scrollbar-width:thin]">
                  {deviceMsgs.map((m) => {
                    const live = m.status === "PENDING" && new Date(m.expiresAt) > new Date();
                    return (
                      <div key={m.id} className={cn("rounded-lg border px-2.5 py-2", live ? "border-amber-400/30 bg-amber-400/[0.07]" : "border-white/10 bg-white/[0.03]")}>
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-slate-500">{m.from} · sms</span>
                          <span className="font-mono text-[9px] text-slate-500">{new Date(m.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                        <p className="mt-1 text-[11px] leading-snug text-slate-300">{m.body}</p>
                        {live && (
                          <p className="mt-1.5 font-mono text-lg font-bold tracking-[0.3em] text-amber-200">{m.code}</p>
                        )}
                      </div>
                    );
                  })}
                  {deviceMsgs.length === 0 && <p className="px-1 py-4 text-center text-[11px] text-slate-500">No messages yet — OTPs land here.</p>}
                </div>
              </PopoverContent>
            </Popover>

            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full text-slate-400 hover:bg-white/10" onClick={refreshSide} title="Refresh state">
              <RefreshCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </header>

        {/* body */}
        <main className="flex min-h-0 flex-1 flex-col">
          {tab === "chat" && (
            <div className="grid min-h-0 min-w-0 flex-1 xl:grid-cols-[1fr_300px]">
              <div className="min-h-0 min-w-0">
                <ChatPanel
                  messages={messages}
                  sending={sending}
                  onSend={send}
                  otpPending={state?.otpPending ?? null}
                  upsellOffer={state?.upsellOffer ?? null}
                  wallet={wallet}
                />
              </div>
              <div className="hidden min-w-0 border-l border-white/10 bg-[#03052E]/40 p-3 xl:block">
                <WalletRail wallet={wallet} auditFeed={auditFeed} />
              </div>
            </div>
          )}
          {tab === "catalog" && <CatalogPanel onSend={sendAndSwitch} />}
          {tab === "campaigns" && <CampaignsPanel onSend={sendAndSwitch} />}
          {tab === "insights" && <InsightsPanel />}
          {tab === "audit" && <AuditPanel />}
        </main>
      </div>
    </div>
  );
}

export { Card };
