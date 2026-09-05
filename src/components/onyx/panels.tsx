"use client";

import { useEffect, useState, useCallback } from "react";
import { TrendingUp, Package, Percent, Timer, ShieldCheck, Sparkles, Megaphone, Eye, Zap, Wallet, Activity, ChevronRight, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, StatusChip, StatCard, fmt, RichText } from "./shared";
import { ToolCallCard } from "./chat";
import type { WalletView } from "@/lib/agent/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ---------------------------------------------------------------- wallet rail

const GUARDRAILS = [
  { icon: Wallet, label: "Wallet balance floor", detail: "declines before funds are ever touched" },
  { icon: Timer, label: "Budget pacing", detail: "monthly ceiling, projected before purchase" },
  { icon: Zap, label: "Velocity control", detail: "3 orders / 10 min burst cap" },
  { icon: ShieldCheck, label: "Auto-approve limit", detail: "trust-adaptive, server-side only" },
  { icon: Eye, label: "Category risk", detail: "high-value watches/audio force OTP" },
  { icon: Activity, label: "OTP gate", detail: "funds held — never released without you" },
];

export function WalletRail({ wallet, auditFeed }: { wallet: WalletView | null; auditFeed: AuditItem[] }) {
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{wallet?.label ?? "Delegated wallet"}</p>
          <StatusChip status="ok">live</StatusChip>
        </div>
        <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-white">
          {wallet ? fmt(wallet.balancePaise) : "—"}
        </p>
        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-[11px]">
            <span className="text-slate-400">Monthly budget · {wallet ? fmt(wallet.spentThisMonthPaise) : "—"} spent</span>
            <span className="font-mono text-slate-300">{wallet?.budgetUsedPct ?? 0}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className={cn("h-full rounded-full transition-all", (wallet?.budgetUsedPct ?? 0) > 75 ? "bg-amber-400" : "bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF]")}
              style={{ width: `${Math.min(100, wallet?.budgetUsedPct ?? 0)}%` }}
            />
          </div>
          <p className="text-[10px] text-slate-500">{wallet ? `${fmt(wallet.remainingBudgetPaise)} runway left this month` : ""}</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/10 pt-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Trust score</p>
            <p className="font-mono text-lg font-semibold text-[#7DD3FC]">{wallet?.trustScore ?? "—"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Auto-approve</p>
            <p className="font-mono text-lg font-semibold text-emerald-300">{wallet ? fmt(wallet.effectiveLimitPaise) : "—"}</p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" /> Guardrail stack
        </p>
        <div className="mt-2.5 space-y-2">
          {GUARDRAILS.map((g) => (
            <div key={g.label} className="flex items-start gap-2">
              <g.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
              <div>
                <p className="text-[11px] font-medium text-slate-200">{g.label}</p>
                <p className="text-[10px] text-slate-500">{g.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-slate-400">
          <Activity className="h-3.5 w-3.5 text-[#00C2FF]" /> Money-action feed
        </p>
        <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {auditFeed.slice(0, 12).map((e) => (
            <div key={e.id} className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5">
              <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                e.type === "PAYMENT_CAPTURED" || e.type === "UPSELL_ACCEPTED" ? "bg-emerald-400" :
                e.type === "DECLINED" || e.type === "OTP_FAILED" ? "bg-rose-400" :
                e.type === "OTP_SENT" ? "bg-amber-400" : "bg-sky-400")} />
              <div className="min-w-0">
                <p className="truncate text-[11px] text-slate-300">{e.summary}</p>
                <p className="font-mono text-[9px] text-slate-600">{new Date(e.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · {e.type}</p>
              </div>
            </div>
          ))}
          {auditFeed.length === 0 && <p className="text-[11px] text-slate-500">No money actions yet — start with the chat.</p>}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- audit types

export interface AuditItem {
  id: string;
  type: string;
  orderId?: string | null;
  amountPaise?: number | null;
  decision?: string | null;
  summary: string;
  payload: unknown;
  at: string;
}

// ---------------------------------------------------------------- catalog

interface CatalogProduct {
  sku: string; name: string; category: string; description: string;
  pricePaise: number; marginPct: number; stock: number; rating: number;
  tags: string[]; compatibleWith: string[];
  campaign: { name: string; type: string; value: number } | null;
}

export function CatalogPanel({ onSend }: { onSend: (m: string) => void }) {
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [peeked, setPeeked] = useState<string | null>(null);
  const [cat, setCat] = useState("all");

  const load = useCallback(() => {
    fetch("/api/catalog").then((r) => r.json()).then((d) => setProducts(d.products ?? [])).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const cats = ["all", ...Array.from(new Set(products.map((p) => p.category)))];
  const shown = cat === "all" ? products : products.filter((p) => p.category === cat);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Agent-readable catalog</h2>
        <StatusChip status="info">{shown.length} SKUs</StatusChip>
        <div className="ml-auto flex gap-1">
          {cats.map((c) => (
            <button key={c} onClick={() => setCat(c)}
              className={cn("rounded-full px-2.5 py-1 text-[11px] transition",
                cat === c ? "bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] text-[#02042B]" : "border border-white/15 bg-white/[0.04] text-slate-300 hover:text-white")}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <p className="max-w-2xl text-xs text-slate-500">
        Every SKU ships margin, stock depth, rating and compatibility edges — the agent ranks recommendations on this.
        Toggle <span className="font-mono text-[#7DD3FC]">agent view</span> to see exactly what the model reads.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => (
          <Card key={p.sku} className="group p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{p.name}</p>
                <p className="font-mono text-[10px] text-slate-500">{p.sku}</p>
              </div>
              <span className="shrink-0 rounded-full border border-white/15 px-2 py-0.5 text-[10px] text-slate-400">{p.category}</span>
            </div>
            <p className="mt-1.5 line-clamp-2 text-[11px] text-slate-500">{p.description}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="font-mono text-lg font-semibold text-white">{fmt(p.pricePaise)}</span>
              {p.campaign && (
                <span className="rounded bg-fuchsia-400/10 px-1.5 py-0.5 text-[10px] text-fuchsia-300">
                  {p.campaign.type === "FLAT_PERCENT" ? `${p.campaign.value}% off live` : p.campaign.type}
                </span>
              )}
              <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">{p.marginPct}% mgn</span>
              <span className="text-[10px] text-amber-300">{p.rating}★</span>
              <span className={cn("text-[10px]", p.stock > 15 ? "text-slate-500" : "text-amber-400")}>{p.stock} left</span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="outline"
                className="h-7 rounded-full border-white/20 bg-transparent text-[11px] text-slate-200 hover:bg-white/10"
                onClick={() => onSend(`buy the ${p.name.split("—")[0].trim().toLowerCase()}`)}>
                <ChevronRight className="h-3 w-3" /> buy via agent
              </Button>
              <Button size="sm" variant="ghost"
                className="h-7 rounded-full px-2 text-[10px] text-slate-500 hover:text-[#7DD3FC]"
                onClick={() => setPeeked(peeked === p.sku ? null : p.sku)}>
                {peeked === p.sku ? "hide" : "agent view"}
              </Button>
            </div>
            {peeked === p.sku && (
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-white/10 bg-[#02042B] p-2.5 font-mono text-[9.5px] leading-relaxed text-[#9EC5FF]">
{JSON.stringify({ sku: p.sku, category: p.category, price_paise: p.pricePaise, margin_pct: p.marginPct, stock: p.stock, rating: p.rating, tags: p.tags, upsell_edges: p.compatibleWith }, null, 1)}
              </pre>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- campaigns

interface Campaign {
  id: string; name: string; type: string; scope: string; value: number; status: string;
  budgetCapPaise: number; impressions: number; conversions: number; incrementalPaise: number;
}

export function CampaignsPanel({ onSend }: { onSend: (m: string) => void }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [form, setForm] = useState({ name: "", type: "FLAT_PERCENT", scope: "category:apparel", value: 10, budgetCapRupees: 5000 });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/campaigns").then((r) => r.json()).then((d) => setCampaigns(d.campaigns ?? [])).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    setBusy(true);
    const res = await fetch("/api/campaigns", { method: "POST", body: JSON.stringify(form) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(d.error ?? "Could not launch campaign");
    else { toast.success(`Campaign “${d.campaign?.name}” is live`); setForm({ ...form, name: "" }); load(); }
    setBusy(false);
  };

  const setStatus = async (id: string, status: string) => {
    await fetch("/api/campaigns", { method: "PATCH", body: JSON.stringify({ id, status }) });
    load();
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Campaign orchestrator</h2>
        <StatusChip status="info">{campaigns.filter((c) => c.status === "ACTIVE").length} live</StatusChip>
      </div>
      <p className="max-w-2xl text-xs text-slate-500">
        Launch a campaign and the agent applies it in-chat instantly — discounts appear as checkout line items, conversions and
        incremental revenue are attributed per campaign. This is the merchant&apos;s growth lever.
      </p>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {campaigns.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Megaphone className="h-4 w-4 text-fuchsia-300" />
                <p className="text-sm font-semibold text-white">{c.name}</p>
                <StatusChip status={c.status === "ACTIVE" ? "ok" : "paused"}>{c.status.toLowerCase()}</StatusChip>
                <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-slate-400">{c.scope}</span>
                <span className="rounded bg-fuchsia-400/10 px-2 py-0.5 text-[10px] text-fuchsia-300">
                  {c.type === "FLAT_PERCENT" ? `${c.value}% off` : c.type}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {c.status === "ACTIVE" ? (
                    <Button size="sm" variant="ghost" className="h-6 gap-1 text-[10px] text-slate-400" onClick={() => setStatus(c.id, "PAUSED")}>
                      <Pause className="h-3 w-3" /> pause
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="h-6 gap-1 text-[10px] text-emerald-300" onClick={() => setStatus(c.id, "ACTIVE")}>
                      <Play className="h-3 w-3" /> resume
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-6 rounded-full border-white/20 text-[10px]" onClick={() => onSend("any offers live?")}>
                    test in chat
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniStat label="Impressions" value={c.impressions.toString()} />
                <MiniStat label="Conversions" value={c.conversions.toString()} />
                <MiniStat label="CVR" value={`${c.impressions ? Math.round((c.conversions / c.impressions) * 100) : 0}%`} />
                <MiniStat label="Incremental" value={fmt(c.incrementalPaise)} accent />
              </div>
            </Card>
          ))}
        </div>

        <Card className="h-fit p-4">
          <p className="text-sm font-semibold text-white">Launch a campaign</p>
          <div className="mt-3 space-y-3">
            <Input placeholder="Campaign name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rounded-xl border-white/15 bg-white/[0.05] text-sm text-white placeholder:text-slate-500" />
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
              <SelectTrigger className="rounded-xl border-white/15 bg-white/[0.05] text-sm text-white"><SelectValue /></SelectTrigger>
              <SelectContent className="border-white/15 bg-[#0A0E3F] text-white">
                <SelectItem value="FLAT_PERCENT">Flat % off</SelectItem>
                <SelectItem value="BUNDLE_DISCOUNT">Bundle discount</SelectItem>
                <SelectItem value="FREE_SHIPPING">Free shipping</SelectItem>
              </SelectContent>
            </Select>
            <Select value={form.scope} onValueChange={(v) => setForm({ ...form, scope: v })}>
              <SelectTrigger className="rounded-xl border-white/15 bg-white/[0.05] text-sm text-white"><SelectValue /></SelectTrigger>
              <SelectContent className="border-white/15 bg-[#0A0E3F] text-white">
                <SelectItem value="category:watches">Watches</SelectItem>
                <SelectItem value="category:apparel">Apparel</SelectItem>
                <SelectItem value="category:audio">Audio</SelectItem>
                <SelectItem value="category:accessories">Accessories</SelectItem>
                <SelectItem value="all">Everything</SelectItem>
              </SelectContent>
            </Select>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-slate-500">Discount %</label>
                <Input type="number" min={1} max={90} value={form.value} onChange={(e) => setForm({ ...form, value: +e.target.value })}
                  className="rounded-xl border-white/15 bg-white/[0.05] text-sm text-white" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-slate-500">Cap (₹)</label>
                <Input type="number" min={500} value={form.budgetCapRupees} onChange={(e) => setForm({ ...form, budgetCapRupees: +e.target.value })}
                  className="rounded-xl border-white/15 bg-white/[0.05] text-sm text-white" />
              </div>
            </div>
            <Button disabled={busy || !form.name.trim()} onClick={create}
              className="w-full rounded-xl bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] text-[#02042B] hover:opacity-90">
              <Zap className="h-4 w-4" /> Launch — live instantly
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={cn("font-mono text-sm font-semibold", accent ? "text-[#7DD3FC]" : "text-white")}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------- insights

interface Insights {
  stats: { revenuePaise: number; upsellRevenuePaise: number; totalRevenuePaise: number; ordersCount: number; paidPrimary: number; aovPaise: number; attachRate: number; offerConversion: number; otpCompletion: number; trustScore: number; declined: number; walletBalancePaise: number };
  funnel: Record<string, number>;
  declineReasons: Record<string, number>;
  buckets: Array<{ label: string; revenuePaise: number; upsellPaise: number }>;
  categoryMix: Record<string, number>;
  campaigns: Array<{ name: string; status: string; impressions: number; conversions: number; incrementalPaise: number; cvr: number }>;
  recentOrders: Array<{ shortId: string; status: string; declineCode?: string | null; revenue: string; role: string; items: string[]; paymentRef?: string | null; at: string }>;
}

export function InsightsPanel() {
  const [d, setD] = useState<Insights | null>(null);
  useEffect(() => { fetch("/api/insights").then((r) => r.json()).then(setD).catch(() => {}); }, []);
  if (!d) return <div className="p-6 text-sm text-slate-500">Loading merchant metrics…</div>;

  const maxBucket = Math.max(1, ...d.buckets.map((b) => b.revenuePaise + b.upsellPaise));
  const funnelTotal = Math.max(1, Object.values(d.funnel).reduce((a, b) => a + b, 0));

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Merchant insights</h2>
        <StatusChip status="ok">Razorpay test mode</StatusChip>
      </div>
      <p className="max-w-2xl text-xs text-slate-500">What the agent earns for the merchant — not just what it processes. Every number traces to an audited money action.</p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenue captured" value={fmt(d.stats.totalRevenuePaise)} sub={`${d.stats.ordersCount} paid orders`} accent icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard label="Agent-grown (upsell)" value={fmt(d.stats.upsellRevenuePaise)} sub={`${d.stats.attachRate}% attach rate`} icon={<Sparkles className="h-4 w-4" />} />
        <StatCard label="AOV" value={fmt(d.stats.aovPaise)} sub={`offer conversion ${d.stats.offerConversion}%`} icon={<Package className="h-4 w-4" />} />
        <StatCard label="OTP completion" value={`${d.stats.otpCompletion}%`} sub={`trust score ${d.stats.trustScore}`} icon={<ShieldCheck className="h-4 w-4" />} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Revenue stream (last 8h)</p>
          <div className="mt-3 flex h-36 items-end gap-2">
            {d.buckets.map((b, i) => {
              const h = ((b.revenuePaise + b.upsellPaise) / maxBucket) * 100;
              const upPart = b.revenuePaise + b.upsellPaise > 0 ? (b.upsellPaise / (b.revenuePaise + b.upsellPaise)) * 100 : 0;
              return (
                <div key={i} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex w-full max-w-10 flex-col justify-end overflow-hidden rounded-md bg-white/5" style={{ height: `${Math.max(4, h)}%` }} title={`base ${fmt(b.revenuePaise)} · upsell ${fmt(b.upsellPaise)}`}>
                    <div className="w-full bg-fuchsia-400/70" style={{ height: `${upPart}%` }} />
                    <div className="w-full bg-gradient-to-t from-[#4A6CFF] to-[#00C2FF]" style={{ height: `${100 - upPart}%` }} />
                  </div>
                  <span className="text-[9px] text-slate-500">{b.label}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex gap-4 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-gradient-to-t from-[#4A6CFF] to-[#00C2FF]" /> base revenue</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-fuchsia-400/70" /> agent upsell</span>
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Decision funnel</p>
          <div className="mt-3 space-y-2.5">
            {(["AUTO_APPROVED", "OTP_REQUIRED", "DECLINED"] as const).map((k) => {
              const v = d.funnel[k] ?? 0;
              const pct = Math.round((v / funnelTotal) * 100);
              const color = k === "AUTO_APPROVED" ? "from-emerald-400 to-emerald-500" : k === "OTP_REQUIRED" ? "from-amber-400 to-amber-500" : "from-rose-400 to-rose-500";
              return (
                <div key={k}>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-slate-300">{k.replace("_", " ").toLowerCase()}</span>
                    <span className="font-mono text-slate-400">{v}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
                    <div className={cn("h-full rounded-full bg-gradient-to-r", color)} style={{ width: `${Math.max(2, pct)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          {Object.keys(d.declineReasons).length > 0 && (
            <>
              <p className="mt-3 text-[10px] uppercase tracking-wider text-slate-500">Declines (handled gracefully)</p>
              <div className="mt-1.5 space-y-1">
                {Object.entries(d.declineReasons).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-[11px]">
                    <span className="text-rose-300">{k.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="font-mono text-slate-400">{v}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <p className="border-b border-white/10 bg-white/[0.03] px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-slate-400">Money-action ledger</p>
          <div className="max-h-72 overflow-y-auto [scrollbar-width:thin]">
            {d.recentOrders.map((o) => (
              <div key={o.shortId} className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5">
                <span className="font-mono text-[11px] text-slate-500">{o.shortId}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-slate-200">{o.items.join(", ")}</p>
                  {o.paymentRef && <p className="font-mono text-[9px] text-slate-600">{o.paymentRef}</p>}
                </div>
                {o.role === "upsell" && <Sparkles className="h-3 w-3 shrink-0 text-fuchsia-300" />}
                <span className="font-mono text-xs text-white">{o.revenue}</span>
                <StatusChip status={o.status === "PAID" ? "ok" : o.status === "AWAITING_OTP" ? "awaiting" : "declined"}>{o.status}</StatusChip>
              </div>
            ))}
            {d.recentOrders.length === 0 && <p className="px-4 py-6 text-center text-xs text-slate-500">No orders yet.</p>}
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Campaign lift</p>
          <div className="mt-3 space-y-2.5">
            {d.campaigns.map((c) => (
              <div key={c.name} className="rounded-lg bg-white/[0.03] p-3">
                <div className="flex items-center gap-2">
                  <Percent className="h-3 w-3 text-fuchsia-300" />
                  <p className="text-xs font-medium text-white">{c.name}</p>
                  <StatusChip status={c.status === "ACTIVE" ? "ok" : "paused"}>{c.status.toLowerCase()}</StatusChip>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <MiniStat label="Impr." value={c.impressions.toString()} />
                  <MiniStat label="Conv." value={c.conversions.toString()} />
                  <MiniStat label="Incr. rev" value={fmt(c.incrementalPaise)} accent />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- audit

export function AuditPanel() {
  const [events, setEvents] = useState<AuditItem[]>([]);
  const [filter, setFilter] = useState("ALL");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/audit?type=${filter}`).then((r) => r.json()).then((d) => setEvents(d.events ?? [])).catch(() => {});
  }, [filter]);
  useEffect(load, [load]);

  const filters = ["ALL", "POLICY", "CHECKOUT", "OTP_SENT", "OTP_VERIFIED", "OTP_FAILED", "PAYMENT_CAPTURED", "DECLINED", "UPSELL_OFFERED", "UPSELL_ACCEPTED", "CAMPAIGN_APPLIED", "SEARCH"];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-white">Audit trail</h2>
        <StatusChip status="ok">{events.length} events</StatusChip>
        <span className="text-[11px] text-slate-500">append-only · every money action explainable</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn("rounded-full px-2.5 py-1 text-[10px] transition",
              filter === f ? "bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] text-[#02042B]" : "border border-white/15 bg-white/[0.04] text-slate-400 hover:text-white")}>
            {f.toLowerCase()}
          </button>
        ))}
      </div>
      <div className="relative space-y-2 border-l border-white/10 pl-5">
        {events.map((e) => (
          <div key={e.id} className="relative">
            <span className={cn("absolute -left-[26px] top-2 h-2.5 w-2.5 rounded-full ring-4 ring-[#03052E]",
              e.type === "PAYMENT_CAPTURED" || e.type === "UPSELL_ACCEPTED" ? "bg-emerald-400" :
              e.type === "DECLINED" || e.type === "OTP_FAILED" ? "bg-rose-400" :
              e.type === "OTP_SENT" ? "bg-amber-400" :
              e.type.startsWith("CAMPAIGN") || e.type === "UPSELL_OFFERED" ? "bg-fuchsia-400" : "bg-sky-400")} />
            <button onClick={() => setOpen(open === e.id ? null : e.id)} className="w-full text-left">
              <Card className="px-3.5 py-2.5 transition hover:border-white/20">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-[10px] text-slate-500">
                    {new Date(e.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[9px] text-slate-300">{e.type}</span>
                  <p className="min-w-0 flex-1 truncate text-xs text-slate-200">{e.summary}</p>
                  {e.amountPaise != null && <span className="font-mono text-xs text-white">{fmt(e.amountPaise)}</span>}
                </div>
                {open === e.id && (
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-white/10 bg-[#02042B] p-2.5 font-mono text-[9.5px] leading-relaxed text-[#9EC5FF]">
{JSON.stringify(e.payload, null, 1)}
                  </pre>
                )}
              </Card>
            </button>
          </div>
        ))}
        {events.length === 0 && <p className="text-xs text-slate-500">No events for this filter.</p>}
      </div>
    </div>
  );
}

export { RichText, ToolCallCard };
