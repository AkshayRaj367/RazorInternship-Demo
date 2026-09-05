"use client";

import { useEffect, useRef } from "react";
import { Search, ShieldCheck, CreditCard, Megaphone, Sparkles, ListOrdered, Wallet, BellRing, Loader2, Send, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Card, StatusChip, RichText, fmt } from "./shared";
import type { ToolCall, UpsellOffer, OtpPending, OrderLite, WalletView } from "@/lib/agent/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- tool cards

const TOOL_ICONS: Record<string, typeof Search> = {
  search_catalog: Search,
  "policy.evaluate": ShieldCheck,
  checkout_and_pay: CreditCard,
  "campaign.apply": Megaphone,
  "campaigns.list": Megaphone,
  "upsell.recommend": Sparkles,
  verify_otp: BellRing,
  "budget.status": Wallet,
  "orders.list": ListOrdered,
};

const statusMap: Record<string, "ok" | "awaiting" | "declined" | "failed" | "info"> = {
  ok: "ok", awaiting_otp: "awaiting", declined: "declined", failed: "failed", info: "info",
};

export function ToolCallCard({ call, onSend }: { call: ToolCall; onSend: (m: string) => void }) {
  const Icon = TOOL_ICONS[call.tool] ?? Search;
  return (
    <Card className="mt-2 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-[#00C2FF]/20 to-[#4A6CFF]/20 text-[#7DD3FC]">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-[11px] font-medium text-slate-300">{call.tool}</span>
        <StatusChip status={statusMap[call.status] ?? "info"}>{call.status.replace("_", " ")}</StatusChip>
        <span className="ml-auto hidden truncate text-[11px] text-slate-500 sm:block max-w-[40%]">{call.summary}</span>
      </div>
      <div className="px-3 py-2.5">
        <ToolBody call={call} onSend={onSend} />
      </div>
    </Card>
  );
}

function ToolBody({ call, onSend }: { call: ToolCall; onSend: (m: string) => void }) {
  switch (call.tool) {
    case "search_catalog": {
      const results = (call.data?.results ?? []) as Array<{ sku: string; name: string; pricePaise: number; marginPct: number; rating: number; stock: number; category: string }>;
      return (
        <div className="space-y-1.5">
          {results.map((r) => (
            <div key={r.sku} className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-200">{r.name}</p>
                <p className="font-mono text-[10px] text-slate-500">{r.sku} · {r.stock} in stock</p>
              </div>
              <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">{r.marginPct}% mgn</span>
              <span className="text-[10px] text-amber-300">{r.rating}★</span>
              <span className="font-mono text-xs font-semibold text-white">{fmt(r.pricePaise)}</span>
            </div>
          ))}
          {call.status === "failed" && <p className="text-xs text-rose-300">No matching SKUs.</p>}
        </div>
      );
    }
    case "policy.evaluate": {
      const d = call.data?.decision as { decision: string; reason: string; rules: Array<{ id: string; label: string; status: string; detail: string }>; appliedLimitPaise: number } | undefined;
      if (!d) return <p className="text-xs text-slate-400">{call.summary}</p>;
      return (
        <div className="space-y-2">
          <div className={cn(
            "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium",
            d.decision === "AUTO_APPROVED" && "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
            d.decision === "OTP_REQUIRED" && "border-amber-400/30 bg-amber-400/10 text-amber-300",
            d.decision === "DECLINED" && "border-rose-400/30 bg-rose-400/10 text-rose-300",
          )}>
            <ShieldCheck className="h-3.5 w-3.5" />
            {d.decision.replace("_", " ")} — applies limit {fmt(d.appliedLimitPaise)}
          </div>
          <div className="space-y-1">
            {d.rules.map((r) => (
              <div key={r.id} className="flex items-start gap-2 text-[11px] leading-snug">
                <span className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
                  r.status === "pass" && "bg-emerald-400/15 text-emerald-300",
                  r.status === "trigger" && "bg-amber-400/15 text-amber-300",
                  r.status === "info" && "bg-sky-400/15 text-sky-300",
                )}>
                  {r.status === "pass" ? "✓" : r.status === "trigger" ? "!" : "i"}
                </span>
                <span className="text-slate-400">
                  <span className="font-medium text-slate-200">{r.label}:</span> {r.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "checkout_and_pay": {
      const d = call.data as { shortId?: string; totalPaise?: number; status?: string; paymentRef?: string; declineCode?: string; reason?: string } | undefined;
      const st = d?.status ?? (call.status === "ok" ? "PAID" : "DECLINED");
      return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="font-mono text-xs text-slate-400">{d?.shortId}</span>
          {d?.totalPaise != null && <span className="font-mono text-lg font-semibold text-white">{fmt(d.totalPaise)}</span>}
          <StatusChip status={st === "PAID" ? "ok" : st === "AWAITING_OTP" ? "awaiting" : "declined"}>
            {st === "AWAITING_OTP" ? "funds held · not released" : st === "PAID" ? "captured" : d?.declineCode ?? "declined"}
          </StatusChip>
          {d?.paymentRef && <span className="font-mono text-[10px] text-slate-500">{d.paymentRef}</span>}
          {d?.reason && <p className="w-full text-[11px] text-slate-400">{d.reason}</p>}
        </div>
      );
    }
    case "campaign.apply": {
      const d = call.data as { campaign?: string; discountPaise?: number; totalPaise?: number } | undefined;
      return (
        <div className="flex items-center gap-3 text-xs">
          <Megaphone className="h-3.5 w-3.5 text-fuchsia-300" />
          <span className="text-slate-200">{d?.campaign}</span>
          {d?.discountPaise != null && <span className="font-mono text-emerald-300">−{fmt(d.discountPaise)}</span>}
          {d?.totalPaise != null && <span className="font-mono text-slate-400">→ {fmt(d.totalPaise)}</span>}
        </div>
      );
    }
    case "upsell.recommend": {
      const offer = call.data?.offer as UpsellOffer | undefined;
      if (!offer) return <p className="text-xs text-slate-400">{call.summary}</p>;
      return (
        <div className="space-y-1.5">
          {offer.items.map((it, i) => (
            <div key={it.product.sku} className="flex flex-wrap items-center gap-2 rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/[0.06] px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-100">{it.product.name}</p>
                <p className="text-[10px] text-slate-500">{it.reason}</p>
              </div>
              <span className="font-mono text-[10px] text-slate-500 line-through">{fmt(it.originalPaise)}</span>
              <span className="font-mono text-xs font-semibold text-fuchsia-200">{fmt(it.bundlePaise)}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 rounded-full border-fuchsia-400/40 px-2.5 text-[10px] text-fuchsia-200 hover:bg-fuchsia-400/10"
                onClick={() => onSend(`add the ${it.product.name.split("—")[0].trim()}`)}
              >
                add · −10%
              </Button>
              <span className="sr-only">Add item {i + 1}</span>
            </div>
          ))}
          <p className="text-[10px] text-slate-500">ranked by margin × rating — revenue growth, audited</p>
        </div>
      );
    }
    case "orders.list": {
      const orders = (call.data?.orders ?? []) as OrderLite[];
      return (
        <div className="space-y-1">
          {orders.slice(0, 5).map((o) => (
            <div key={o.shortId} className="flex items-center gap-2 text-[11px]">
              <span className="font-mono text-slate-500">{o.shortId}</span>
              <span className="truncate text-slate-300">{o.firstItemName}</span>
              <span className="ml-auto font-mono text-slate-200">{fmt(o.totalPaise)}</span>
              <StatusChip status={o.status === "PAID" ? "ok" : o.status === "AWAITING_OTP" ? "awaiting" : "declined"}>{o.status}</StatusChip>
            </div>
          ))}
        </div>
      );
    }
    default:
      return <p className="text-xs text-slate-400">{call.summary}</p>;
  }
}

// ---------------------------------------------------------------- chat panel

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ToolCall[];
}

export function ChatPanel({
  messages, sending, onSend, otpPending, upsellOffer, wallet,
}: {
  messages: ChatMessage[];
  sending: boolean;
  onSend: (m: string) => void;
  otpPending: OtpPending | null;
  upsellOffer: UpsellOffer | null;
  wallet: WalletView | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const otpRef = useRef("");

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, sending, otpPending]);

  const chips: string[] = otpPending
    ? ["Read the OTP from the bell ↑", "What's my budget?"]
    : upsellOffer
      ? [`add the ${upsellOffer.items[0].product.name.split("—")[0].trim()}`, "No thanks, skip the offer"]
      : [
          "Buy a premium watch for ₹10,000",
          "Buy a hoodie under ₹2,000",
          "Any offers live?",
          "What's my budget?",
          "How am I protected?",
        ];

  const exp = otpPending ? Math.max(0, Math.floor((new Date(otpPending.expiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "user" ? (
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] px-4 py-2.5 text-sm font-medium text-[#02042B] shadow-lg shadow-[#4A6CFF]/20">
                  {m.text}
                </div>
              ) : (
                <div className="w-full max-w-full">
                  <div className="rounded-2xl rounded-bl-md border border-white/10 bg-white/[0.05] px-4 py-3">
                    <RichText text={m.text} />
                  </div>
                  {m.toolCalls?.map((c, j) => (
                    <ToolCallCard key={j} call={c} onSend={onSend} />
                  ))}
                </div>
              )}
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.05] px-4 py-3">
                <Loader2 className="h-4 w-4 animate-spin text-[#7DD3FC]" />
                <span className="text-sm text-slate-400">agent is running tools…</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-white/10 bg-[#030530]/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto max-w-2xl space-y-2.5">
          {otpPending && (
            <Card className="flex flex-wrap items-center gap-3 border-amber-400/30 bg-amber-400/[0.07] px-3 py-2.5">
              <BellRing className="h-4 w-4 animate-pulse text-amber-300" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-amber-200">
                  {otpPending.orderShortId} · {fmt(otpPending.amountPaise)} held — enter the OTP from {otpPending.maskedDevice}
                </p>
                <p className="text-[10px] text-amber-300/70">expires in {exp} min · 3 attempts · funds release only on success</p>
              </div>
              <InputOTP maxLength={6} onChange={(v) => (otpRef.current = v)}>
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((s) => (
                    <InputOTPSlot key={s} index={s} className="border-white/20 bg-white/5 text-white" />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <Button
                size="sm"
                className="bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] text-[#02042B] hover:opacity-90"
                disabled={otpRef.current.length !== 6 || sending}
                onClick={() => onSend(`verify otp ${otpRef.current}`)}
              >
                Verify
              </Button>
            </Card>
          )}

          <div className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {chips.map((c) => (
              <button
                key={c}
                onClick={() => !sending && onSend(c.startsWith("Read") || c === "No thanks, skip the offer" ? (c.includes("No thanks") ? c : c) : c)}
                className="shrink-0 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1 text-[11px] text-slate-300 transition hover:border-[#00C2FF]/50 hover:text-white"
              >
                {c}
              </button>
            ))}
          </div>

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("m") as HTMLInputElement);
              if (input.value.trim()) { onSend(input.value.trim()); input.value = ""; }
            }}
          >
            <Input
              name="m"
              placeholder={wallet ? `Ask Onyx · auto-approves ≤ ${fmt(wallet.effectiveLimitPaise)} · everything else needs OTP` : "Ask Onyx to buy something…"}
              className="rounded-xl border-white/15 bg-white/[0.05] text-sm text-white placeholder:text-slate-500 focus-visible:ring-[#00C2FF]/50"
              disabled={sending}
            />
            <Button type="submit" size="icon" disabled={sending} className="rounded-xl bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] text-[#02042B] hover:opacity-90">
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

export { ChevronDown };
