"use client";

import { cn } from "@/lib/utils";
import { type ReactNode } from "react";

export const fmt = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export const fmtNum = (n: number) => n.toLocaleString("en-IN");

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm", className)}>
      {children}
    </div>
  );
}

export function StatusChip({ status, children }: { status: "ok" | "awaiting" | "declined" | "failed" | "info" | "paused"; children?: ReactNode }) {
  const styles: Record<string, string> = {
    ok: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
    awaiting: "bg-amber-400/10 text-amber-300 border-amber-400/30",
    declined: "bg-rose-400/10 text-rose-300 border-rose-400/30",
    failed: "bg-rose-400/10 text-rose-300 border-rose-400/30",
    info: "bg-sky-400/10 text-sky-300 border-sky-400/30",
    paused: "bg-white/10 text-slate-300 border-white/20",
  };
  const dots: Record<string, string> = {
    ok: "bg-emerald-400", awaiting: "bg-amber-400 animate-pulse",
    declined: "bg-rose-400", failed: "bg-rose-400", info: "bg-sky-400", paused: "bg-slate-400",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", styles[status])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dots[status])} />
      {children}
    </span>
  );
}

export function StatCard({ label, value, sub, accent, icon }: { label: string; value: string; sub?: string; accent?: boolean; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-slate-400">{label}</p>
        {icon && <span className="text-slate-500">{icon}</span>}
      </div>
      <p className={cn("mt-2 font-mono text-2xl font-semibold tracking-tight", accent ? "bg-gradient-to-r from-[#00C2FF] to-[#4A6CFF] bg-clip-text text-transparent" : "text-white")}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </Card>
  );
}

/** Minimal markdown: **bold**, `code`, lists, paragraphs. */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n\n+/);
  const renderInline = (s: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m: RegExpExecArray | null, key = 0;
    while ((m = regex.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      if (m[0].startsWith("**")) parts.push(<strong key={key++} className="font-semibold text-white">{m[0].slice(2, -2)}</strong>);
      else parts.push(<code key={key++} className="break-all rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em] text-[#7DD3FC]">{m[0].slice(1, -1)}</code>);
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  return (
    <div className={cn("break-words space-y-2 leading-relaxed", className)}>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*[-•]\s/.test(l) || /^\s*\d+\.\s/.test(l) || l === "")) {
          const ordered = /^\s*\d+\.\s/.test(lines.find((l) => l.trim()) ?? "");
          const items = lines.filter((l) => l.trim() && !/^\s*$/.test(l));
          const List = ordered ? "ol" : "ul";
          return (
            <List key={i} className={cn("space-y-1 pl-4", ordered ? "list-decimal" : "list-disc", "marker:text-slate-500")}>
              {items.map((it, j) => (
                <li key={j} className="text-sm text-slate-300">{renderInline(it.replace(/^\s*[-•]\s|^\s*\d+\.\s/, ""))}</li>
              ))}
            </List>
          );
        }
        return <p key={i} className="text-sm text-slate-300">{renderInline(b)}</p>;
      })}
    </div>
  );
}
