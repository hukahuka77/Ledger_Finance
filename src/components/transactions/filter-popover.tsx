"use client";

import { SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, Input, Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { ACCOUNT_TYPES, TRANSACTION_TYPE_OPTIONS, type AccountType } from "@/lib/domain";
import { DEFAULT_FILTERS, UNCATEGORIZED, activeFilterCount, type TransactionFilters } from "@/lib/filters";
import { useAccounts, useCategoryIndex, useTags } from "@/lib/queries/reference";

export function MultiList({
  items,
  selected,
  onChange,
  className,
}: {
  items: { value: string; label: React.ReactNode; indent?: boolean; heading?: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
  className?: string;
}) {
  return (
    <div className={cn("max-h-44 overflow-y-auto rounded-md border border-line bg-paper py-1", className)}>
      {items.map((it) =>
        it.heading ? (
          <p key={`h-${it.heading}`} className="px-2.5 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">
            {it.heading}
          </p>
        ) : (
          <label key={it.value} className={cn("flex h-7 cursor-pointer items-center gap-2 px-2.5 text-[13px] hover:bg-hover", it.indent && "pl-6")}>
            <Checkbox
              checked={selected.includes(it.value)}
              label={typeof it.label === "string" ? it.label : it.value}
              onChange={(on) => onChange(on ? [...selected, it.value] : selected.filter((s) => s !== it.value))}
            />
            <span className="truncate">{it.label}</span>
          </label>
        ),
      )}
    </div>
  );
}

export function FilterPopover({ filters, onChange }: { filters: TransactionFilters; onChange: (f: TransactionFilters) => void }) {
  const [open, setOpen] = useState(false);
  const { data: accounts } = useAccounts();
  const cats = useCategoryIndex();
  const { data: tags } = useTags();
  const count = activeFilterCount(filters);
  const set = (patch: Partial<TransactionFilters>) => onChange({ ...filters, ...patch });

  const accountItems: { value: string; label: string; heading?: string }[] = [];
  (Object.keys(ACCOUNT_TYPES) as AccountType[]).forEach((type) => {
    const list = (accounts ?? []).filter((a) => a.account_type === type);
    if (!list.length) return;
    accountItems.push({ value: "", label: "", heading: ACCOUNT_TYPES[type] });
    list.forEach((a) => accountItems.push({ value: a.id, label: `${a.name}${a.last_four ? ` ··${a.last_four}` : ""}` }));
  });

  const categoryItems: { value: string; label: string; indent?: boolean }[] = [{ value: UNCATEGORIZED, label: "Uncategorized" }];
  cats.parents.forEach((p) => {
    categoryItems.push({ value: p.id, label: p.name });
    cats.childrenOf(p.id).forEach((k) => categoryItems.push({ value: k.id, label: k.name, indent: true }));
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="md"
          variant={count ? "primary" : "secondary"}
          className={cn(count && "bg-accent-soft text-accent border-accent/30 hover:bg-accent-soft hover:border-accent/50")}
        >
          <SlidersHorizontal /> <span className="hidden sm:inline">Filter</span>
          {count ? <span className="tabular text-[12px]">{count}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(640px,calc(100vw-24px))] p-0">
        <div className="grid max-h-[70vh] grid-cols-1 gap-4 overflow-y-auto p-4 sm:grid-cols-2">
          <Field label="Date range">
            <div className="flex items-center gap-2">
              <Input type="date" aria-label="From" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
              <span className="text-ink-3">–</span>
              <Input type="date" aria-label="To" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
            </div>
          </Field>
          <Field label="Amount range">
            <div className="flex items-center gap-2">
              <Input
                inputMode="decimal"
                aria-label="Minimum amount"
                placeholder="Min"
                value={filters.min}
                onChange={(e) => set({ min: e.target.value.replace(/[^\d.]/g, "") })}
              />
              <span className="text-ink-3">–</span>
              <Input
                inputMode="decimal"
                aria-label="Maximum amount"
                placeholder="Max"
                value={filters.max}
                onChange={(e) => set({ max: e.target.value.replace(/[^\d.]/g, "") })}
              />
            </div>
          </Field>
          <Field label="Accounts">
            <MultiList items={accountItems} selected={filters.accounts} onChange={(v) => set({ accounts: v })} />
          </Field>
          <Field label="Categories" hint="Selecting a parent includes its subcategories.">
            <MultiList items={categoryItems} selected={filters.categories} onChange={(v) => set({ categories: v })} />
          </Field>
          <Field label="Transaction type">
            <MultiList items={TRANSACTION_TYPE_OPTIONS} selected={filters.types} onChange={(v) => set({ types: v })} className="max-h-none" />
          </Field>
          <div className="space-y-3">
            <Field label="Tags">
              {tags?.length ? (
                <MultiList
                  items={tags.map((t) => ({ value: t.id, label: `#${t.name}` }))}
                  selected={filters.tags}
                  onChange={(v) => set({ tags: v })}
                  className="max-h-24"
                />
              ) : (
                <p className="text-[13px] text-ink-3">No tags yet.</p>
              )}
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Status" htmlFor="f-status">
                <Select id="f-status" value={filters.status} onChange={(e) => set({ status: e.target.value as TransactionFilters["status"] })}>
                  <option value="">Any</option>
                  <option value="pending">Pending</option>
                  <option value="posted">Cleared</option>
                </Select>
              </Field>
              <Field label="Recurring" htmlFor="f-rec">
                <Select id="f-rec" value={filters.recurring} onChange={(e) => set({ recurring: e.target.value as TransactionFilters["recurring"] })}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
              <Field label="Excluded" htmlFor="f-exc">
                <Select id="f-exc" value={filters.excluded} onChange={(e) => set({ excluded: e.target.value as TransactionFilters["excluded"] })}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </Field>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-line-soft px-4 py-2.5">
          <Button
            size="sm"
            variant="quiet"
            disabled={!count}
            onClick={() => onChange({ ...DEFAULT_FILTERS, q: filters.q, review: filters.review, sort: filters.sort })}
          >
            Clear filters
          </Button>
          <Button size="sm" variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
