"use client";

import { ArrowLeftRight, Repeat, Split } from "lucide-react";
import { memo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { CategoryPicker, CategoryPill, uncategorizedLabel } from "@/components/transactions/category-picker";
import { cn } from "@/lib/cn";
import type { Account, Category, LedgerTransaction } from "@/lib/domain";
import { formatShortDate } from "@/lib/dates";
import { formatLedgerAmount } from "@/lib/money";

export const TransactionRow = memo(function TransactionRow({
  txn,
  account,
  category,
  selected,
  checked,
  onSelect,
  onCheck,
  rowRef,
  showDate,
  onCategoryChange,
}: {
  txn: LedgerTransaction;
  account: Account | undefined;
  category: Category | undefined;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onCheck: (id: string, checked: boolean, shift: boolean) => void;
  rowRef?: (el: HTMLDivElement | null) => void;
  showDate?: boolean;
  /** When set, clicking the category opens a picker right on the row. */
  onCategoryChange?: (id: string, categoryId: string | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const reviewed = txn.review_status === "reviewed";
  const inflow = txn.amount > 0;
  const isSplit = txn.transaction_splits.length > 0;
  const isTransfer = txn.transaction_type === "transfer" || txn.transaction_type === "credit_card_payment";
  const notCounted = isTransfer || txn.excluded || txn.transaction_type === "adjustment";

  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onSelect(txn.id)}
      className={cn(
        "group relative flex min-h-11 cursor-default items-center gap-3 border-b border-line-soft py-1.5 pr-3 pl-4 outline-none sm:h-11 sm:py-0 sm:pl-5",
        selected ? "bg-selected" : checked ? "bg-hover/70" : "hover:bg-hover/60",
      )}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" /> : null}
      <Checkbox
        checked={checked}
        label={`Select ${txn.merchant_name}`}
        onChange={(v, e) => onCheck(txn.id, v, e.shiftKey)}
        className={cn(!checked && "opacity-60 group-hover:opacity-100")}
      />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2.5">
          {showDate ? <span className="tabular w-12 shrink-0 text-[12.5px] text-ink-3">{formatShortDate(txn.transaction_date)}</span> : null}
          <span className={cn("min-w-0 shrink truncate text-[14.5px]", reviewed ? "text-ink-2" : "font-medium text-ink")}>{txn.merchant_name}</span>
          <span className="flex shrink-0 items-center gap-1 text-ink-3">
            {isSplit ? <Split className="size-3.5" aria-label="Split" /> : null}
            {txn.recurring_item_id ? <Repeat className="size-3.5" aria-label="Recurring" /> : null}
            {isTransfer ? <ArrowLeftRight className="size-3.5" aria-label="Transfer" /> : null}
          </span>
          {txn.status === "pending" ? (
            <span className="shrink-0 rounded-sm border border-line px-1 text-[10.5px] font-medium tracking-wide text-ink-3 uppercase">Pending</span>
          ) : null}
          <span className="hidden min-w-0 flex-1 truncate text-[13.5px] text-ink-3 md:block">
            {account ? `${account.name}${account.last_four ? ` ${account.last_four}` : ""}` : ""}
          </span>
        </div>
        {/* Phones: account and category move to a second line */}
        <p className="truncate text-[12px] text-ink-3 sm:hidden">
          {[account?.name, isSplit ? `Split · ${txn.transaction_splits.length}` : (category?.name ?? uncategorizedLabel(txn.transaction_type))]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="hidden w-[180px] shrink-0 justify-start sm:flex">
        {isSplit ? (
          <span className="inline-flex h-[22px] items-center rounded-full border border-line px-2 text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            Split · {txn.transaction_splits.length}
          </span>
        ) : onCategoryChange ? (
          <CategoryPicker value={txn.category_id} open={pickerOpen} onOpenChange={setPickerOpen} onChange={(cid) => onCategoryChange(txn.id, cid)}>
            <button
              type="button"
              aria-label={`Change category for ${txn.merchant_name}`}
              onClick={(e) => e.stopPropagation()}
              className="max-w-full rounded-full outline-none hover:ring-1 hover:ring-line focus-visible:ring-2 focus-visible:ring-accent"
            >
              <CategoryPill category={category} muted={reviewed && !pickerOpen} transactionType={txn.transaction_type} />
            </button>
          </CategoryPicker>
        ) : (
          <CategoryPill category={category} muted={reviewed} transactionType={txn.transaction_type} />
        )}
      </div>

      <span
        className={cn(
          "tabular w-[92px] shrink-0 text-right text-[14px]",
          notCounted ? "text-ink-3" : inflow ? "text-sage" : reviewed ? "text-ink-2" : "text-ink",
        )}
        title={notCounted ? "Not counted in spending or income" : undefined}
      >
        {formatLedgerAmount(txn.amount)}
      </span>

      <span className="flex w-3 shrink-0 justify-center" aria-label={reviewed ? "Reviewed" : "Unreviewed"}>
        {!reviewed ? <span className="size-[7px] rounded-full bg-accent" /> : null}
      </span>
    </div>
  );
});
