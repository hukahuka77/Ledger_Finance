"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cn";
import type { Category } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import type { CategoryIndex } from "@/lib/queries/reference";

type SpendRow = { category_id: string | null; amount: number; transaction_count: number };
export type Rollup = { id: string | null; name: string; category?: Category; amount: number; count: number; children: Rollup[] };

/** Roll subcategory spending up into its parent; drop net-negative (refund-dominated) lines. */
export function rollupSpending(rows: SpendRow[], cats: CategoryIndex): Rollup[] {
  const parents = new Map<string, Rollup>();
  for (const r of rows) {
    const cat = r.category_id ? cats.byId.get(r.category_id) : undefined;
    const parent = cat?.parent_category_id ? cats.byId.get(cat.parent_category_id) : cat;
    const key = parent?.id ?? "none";
    const p = parents.get(key) ?? { id: parent?.id ?? null, name: parent?.name ?? "Uncategorized", category: parent, amount: 0, count: 0, children: [] };
    p.amount += r.amount;
    p.count += r.transaction_count;
    if (cat && parent && cat.id !== parent.id)
      p.children.push({ id: cat.id, name: cat.name, category: cat, amount: r.amount, count: r.transaction_count, children: [] });
    else if (parent)
      p.children.push({ id: parent.id, name: `${parent.name} (general)`, category: parent, amount: r.amount, count: r.transaction_count, children: [] });
    parents.set(key, p);
  }
  return [...parents.values()]
    .map((p) => ({ ...p, amount: Math.round(p.amount * 100) / 100, children: p.children.filter((c) => c.amount > 0.005).sort((a, b) => b.amount - a.amount) }))
    .filter((p) => p.amount > 0.005)
    .sort((a, b) => b.amount - a.amount);
}

/** Restrained horizontal bars: one hue, labels and values in ink. */
export function CategoryBars({ rows, from, to, accountId, limit = 8 }: { rows: Rollup[]; from: string; to: string; accountId?: string; limit?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const max = rows[0]?.amount ?? 1;
  const shown = showAll ? rows : rows.slice(0, limit);
  const href = (id: string | null) => {
    const sp = new URLSearchParams({ from, to, category: id ?? "none" });
    if (accountId) sp.set("account", accountId);
    return `/transactions?${sp.toString()}`;
  };

  return (
    <div>
      <ul className="space-y-0.5">
        {shown.map((r) => {
          const key = r.id ?? "none";
          const expanded = open === key;
          return (
            <li key={key}>
              <div className="group grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-3 rounded-md py-1.5 sm:grid-cols-[minmax(0,180px)_1fr_auto]">
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : key)}
                  disabled={!r.children.length}
                  className="flex min-w-0 items-center gap-1 text-left text-[13.5px] text-ink disabled:cursor-default"
                  aria-expanded={r.children.length ? expanded : undefined}
                >
                  <ChevronRight
                    className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", expanded && "rotate-90", !r.children.length && "invisible")}
                  />
                  <span className="truncate">{r.name}</span>
                </button>
                <Link href={href(r.id)} className="block h-3.5" title={`${r.name}: ${formatMoney(r.amount)} · ${r.count} transactions`}>
                  <span
                    className="block h-full rounded-r-[3px] bg-accent/85 transition-colors group-hover:bg-accent"
                    style={{ width: `${Math.max(1.5, (r.amount / max) * 100)}%` }}
                  />
                </Link>
                <span className="tabular w-[92px] text-right text-[13.5px] text-ink">
                  {formatMoney(r.amount, { cents: false })}
                  <span className="ml-1.5 text-[11.5px] text-ink-3">{total ? Math.round((r.amount / total) * 100) : 0}%</span>
                </span>
              </div>
              {expanded ? (
                <ul className="mb-2 ml-5 border-l border-line-soft pl-3">
                  {r.children.map((c) => (
                    <li
                      key={c.id ?? c.name}
                      className="grid grid-cols-[minmax(0,150px)_1fr_auto] items-center gap-3 py-1 sm:grid-cols-[minmax(0,164px)_1fr_auto]"
                    >
                      <Link href={href(c.id)} className="truncate text-[13px] text-ink-2 hover:text-ink hover:underline">
                        {c.name}
                      </Link>
                      <span className="block h-2">
                        <span className="block h-full rounded-r-[2px] bg-accent/45" style={{ width: `${Math.max(1.5, (c.amount / max) * 100)}%` }} />
                      </span>
                      <span className="tabular w-[92px] text-right text-[12.5px] text-ink-2">{formatMoney(c.amount, { cents: false })}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > limit ? (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-[12.5px] text-ink-2 hover:text-ink">
          {showAll ? "Show fewer" : `Show all ${rows.length} categories`}
        </button>
      ) : null}
    </div>
  );
}
