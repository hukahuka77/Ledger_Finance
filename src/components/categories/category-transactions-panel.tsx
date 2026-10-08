"use client";

import * as D from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { MiniTransactionList } from "@/components/shared/mini-transaction-list";
import { CategoryIcon } from "@/components/ui/category-icon";
import { Select } from "@/components/ui/input";
import { periodRange, type PeriodKey } from "@/lib/dates";
import type { Category, LedgerTransaction } from "@/lib/domain";
import { formatLedgerAmount } from "@/lib/money";
import { qk, unwrap, useCategoryIndex } from "@/lib/queries/reference";
import { TRANSACTION_SELECT } from "@/lib/queries/transactions";
import { getSupabase } from "@/lib/supabase/client";

type PanelPeriod = Exclude<PeriodKey, "custom"> | "all";
const PERIODS: { value: PanelPeriod; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "this_year", label: "This year" },
  { value: "all", label: "All time" },
];
const LIMIT = 500;

/** Slide-over from the right listing a category's transactions (a group includes its subcategories). */
export function CategoryTransactionsPanel({ category, onClose }: { category: Category | null; onClose: () => void }) {
  return (
    <D.Root open={category !== null} onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[#2c2926]/15" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-[460px] max-w-[100vw] flex-col border-l border-line bg-paper shadow-[0_12px_40px_-12px_rgba(60,50,40,0.3)] outline-none">
          {category ? <PanelBody key={category.id} category={category} onClose={onClose} /> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PanelBody({ category: c, onClose }: { category: Category; onClose: () => void }) {
  const cats = useCategoryIndex();
  const [period, setPeriod] = useState<PanelPeriod>("last_3_months");
  const range = period === "all" ? null : periodRange(period);
  const ids = cats.expand(c.id);
  const parent = c.parent_category_id ? cats.byId.get(c.parent_category_id) : undefined;

  const txns = useQuery({
    queryKey: [...qk.transactions, "by-category", ids.join(","), range?.from ?? null, range?.to ?? null],
    queryFn: () => {
      let q = getSupabase().from("transactions").select(TRANSACTION_SELECT).in("category_id", ids);
      if (range) q = q.gte("transaction_date", range.from).lte("transaction_date", range.to);
      return unwrap<LedgerTransaction[]>(q.order("transaction_date", { ascending: false }).order("created_at", { ascending: false }).limit(LIMIT));
    },
  });
  const rows = txns.data ?? [];
  const excluded = rows.filter((t) => t.excluded).length;
  const total = rows.filter((t) => !t.excluded).reduce((s, t) => s + t.amount, 0);
  const ledgerHref = `/transactions?${new URLSearchParams({ category: c.id, ...(range ? { from: range.from, to: range.to } : {}) }).toString()}`;

  return (
    <>
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span className="mt-1 flex size-7 shrink-0 items-center justify-center">
          {c.icon ? (
            <CategoryIcon name={c.icon} className="size-4" color={c.color} />
          ) : (
            <span className="size-3 rounded-full" style={{ background: c.color }} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {parent ? <p className="text-[12px] text-ink-3">{parent.name}</p> : null}
          <D.Title className="truncate font-serif text-[22px] leading-tight">
            {c.code ? <span className="mr-2 font-mono text-[14px] text-ink-3">{c.code}</span> : null}
            {c.name}
          </D.Title>
          <D.Description className="mt-0.5 text-[12.5px] text-ink-3">
            {cats.childrenOf(c.id).length ? "Including its subcategories." : "Transactions in this category."}
          </D.Description>
        </div>
        <D.Close aria-label="Close" className="rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink">
          <X className="size-4" />
        </D.Close>
      </div>

      <div className="flex items-center gap-3 border-b border-line-soft px-5 py-3">
        <Select aria-label="Period" className="w-40" value={period} onChange={(e) => setPeriod(e.target.value as PanelPeriod)}>
          {PERIODS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <div className="ml-auto text-right">
          <p className="tabular font-serif text-[18px] leading-none">{txns.isLoading ? "—" : formatLedgerAmount(total, { cents: false })}</p>
          <p className="mt-1 text-[12px] text-ink-3">
            {txns.isLoading
              ? "Loading…"
              : `${rows.length.toLocaleString()}${rows.length === LIMIT ? "+" : ""} transaction${rows.length === 1 ? "" : "s"}${
                  excluded ? ` · ${excluded.toLocaleString()} excluded from the total` : ""
                }`}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
        <MiniTransactionList rows={rows} loading={txns.isLoading} empty="No transactions in this period." />
      </div>

      <div className="border-t border-line px-5 py-3">
        <Link href={ledgerHref} onClick={onClose} className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">
          <ExternalLink className="size-3.5" /> Open in Transactions
        </Link>
      </div>
    </>
  );
}
