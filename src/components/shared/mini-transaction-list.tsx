"use client";

import Link from "next/link";
import { CategoryPill } from "@/components/transactions/category-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatListDate } from "@/lib/dates";
import type { LedgerTransaction } from "@/lib/domain";
import { formatLedgerAmount } from "@/lib/money";
import { useAccountIndex, useCategoryIndex } from "@/lib/queries/reference";

export function MiniTransactionList({
  rows,
  loading,
  empty = "No transactions.",
  showAccount = true,
}: {
  rows: LedgerTransaction[] | undefined;
  loading?: boolean;
  empty?: string;
  showAccount?: boolean;
}) {
  const accounts = useAccountIndex();
  const cats = useCategoryIndex();
  if (loading)
    return (
      <div className="space-y-3 py-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  if (!rows?.length) return <p className="py-4 text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-line-soft">
      {rows.map((t) => (
        <li key={t.id}>
          <Link href={`/transactions?id=${t.id}`} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover/60">
            <span className="tabular w-[74px] shrink-0 text-[12.5px] text-ink-3">{formatListDate(t.transaction_date)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-ink">{t.merchant_name}</span>
              {showAccount ? <span className="block truncate text-[12px] text-ink-3">{accounts.get(t.account_id)?.name}</span> : null}
            </span>
            <span className="hidden sm:block">
              <CategoryPill category={t.category_id ? cats.byId.get(t.category_id) : null} transactionType={t.transaction_type} />
            </span>
            <span
              className={cn("tabular w-24 shrink-0 text-right text-[13.5px]", t.excluded ? "text-ink-3" : t.amount > 0 ? "text-sage" : "text-ink")}
              title={t.excluded ? "Excluded: not counted in totals" : undefined}
            >
              <span className={cn(t.excluded && "line-through decoration-ink-3/60")}>{formatLedgerAmount(t.amount)}</span>
              {t.excluded ? <span className="block text-[11px] text-ink-3">Excluded</span> : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
