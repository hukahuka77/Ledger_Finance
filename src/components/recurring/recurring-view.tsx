"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { RecurringFormDialog } from "@/components/forms/recurring-form";
import { Page, PageHeader } from "@/components/layout/app-shell";
import { CategoryPill } from "@/components/transactions/category-picker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/checkbox";
import { Segmented } from "@/components/ui/segmented";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { nextDueDate } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { formatShortDate, monthlyFactor, todayISO, toISODate } from "@/lib/dates";
import { EVENT_TYPE_COLORS, FREQUENCIES, RECURRING_TO_EVENT, RECURRING_TYPES, type Frequency, type RecurringItem, type RecurringType } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { useRecurringSuggestions } from "@/lib/queries/recurring-suggestions";
import type { RecurringSuggestion } from "@/lib/recurring-detect";
import { qk, unwrap, useAccountIndex, useCategoryIndex, useRecurringItems, useSaveRecurring } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";
import { addDays } from "date-fns";

type Tab = "all" | "subscription" | "bill" | "income" | "other";
const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "subscription", label: "Subscriptions" },
  { value: "bill", label: "Bills & loans" },
  { value: "income", label: "Income" },
  { value: "other", label: "Transfers & other" },
];
const inTab = (t: Tab, type: string) =>
  t === "all" ||
  (t === "subscription" && type === "subscription") ||
  (t === "bill" && ["bill", "loan"].includes(type)) ||
  (t === "income" && type === "income") ||
  // Card payments move money between your own accounts; the spending is on the card.
  (t === "other" && ["transfer", "credit_card_payment", "other"].includes(type));

/** Recent linked transactions for all items, used to compute the effective next due date. */
export function useRecentLinked() {
  return useQuery({
    queryKey: [...qk.transactions, "recurring-linked"],
    queryFn: () =>
      unwrap<{ id: string; transaction_date: string; recurring_item_id: string }[]>(
        getSupabase()
          .from("transactions")
          .select("id, transaction_date, recurring_item_id")
          .not("recurring_item_id", "is", null)
          .gte("transaction_date", toISODate(addDays(new Date(), -45)))
          .limit(1000),
      ),
  });
}

export function RecurringView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get("type")) ? params.get("type") : "all") as Tab;
  const { data: items, isLoading } = useRecurringItems();
  const linked = useRecentLinked();
  const accounts = useAccountIndex();
  const cats = useCategoryIndex();
  const save = useSaveRecurring();
  const [formOpen, setFormOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const today = todayISO();

  const rows = useMemo(() => {
    const byItem = new Map<string, { id: string; transaction_date: string }[]>();
    (linked.data ?? []).forEach((t) => byItem.set(t.recurring_item_id, [...(byItem.get(t.recurring_item_id) ?? []), t]));
    return (items ?? [])
      .filter((r) => inTab(tab, r.recurring_type) && (showInactive || r.active))
      .map((r) => ({ item: r, next: nextDueDate(r, byItem.get(r.id) ?? [], today) }))
      .sort((a, b) => Number(b.item.active) - Number(a.item.active) || a.next.localeCompare(b.next));
  }, [items, linked.data, tab, showInactive, today]);

  const totals = useMemo(() => {
    const active = (items ?? []).filter((r) => r.active);
    const eq = (r: RecurringItem) => r.expected_amount * monthlyFactor(r.frequency, r.interval_value);
    const out = active.filter((r) => !["income", "transfer", "credit_card_payment"].includes(r.recurring_type)).reduce((s, r) => s + eq(r), 0);
    const inc = active.filter((r) => r.recurring_type === "income").reduce((s, r) => s + eq(r), 0);
    const subs = active.filter((r) => r.recurring_type === "subscription").reduce((s, r) => s + eq(r), 0);
    return { out, inc, subs };
  }, [items]);

  const setTab = (t: Tab) => {
    const sp = new URLSearchParams(params.toString());
    if (t === "all") sp.delete("type");
    else sp.set("type", t);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  return (
    <Page>
      <PageHeader
        title="Recurring"
        subtitle="Subscriptions, bills, loans, income and transfers that repeat. They drive the calendar."
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            <Plus /> New recurring
          </Button>
        }
      />

      <dl className="mb-8 grid grid-cols-3 border-y border-line">
        {[
          ["Recurring outflows / month", totals.out],
          ["Subscriptions / month", totals.subs],
          ["Recurring income / month", totals.inc],
        ].map(([label, v], i) => (
          <div key={label as string} className={cn("px-1 py-4 sm:px-4", i < 2 && "border-r border-line")}>
            <dt className="text-[12px] text-ink-2">{label}</dt>
            <dd className="tabular mt-1 font-serif text-[22px] leading-none">{formatMoney(v as number, { cents: false })}</dd>
            {i === 1 ? <dd className="mt-1 text-[12px] text-ink-3">{formatMoney((v as number) * 12, { cents: false })} a year</dd> : null}
          </div>
        ))}
      </dl>

      <Suggestions />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented ariaLabel="Type" size="sm" value={tab} onChange={setTab} options={TABS} />
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <Switch checked={showInactive} onChange={setShowInactive} label="Show inactive" /> Show inactive
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !rows.length ? (
        <EmptyState
          title="No recurring bills yet."
          body="Add a recurring transaction to see upcoming charges here and on the calendar. You can also mark any transaction as recurring from its detail panel."
          action={<Button onClick={() => setFormOpen(true)}>New recurring item</Button>}
        />
      ) : (
        <ul className="divide-y divide-line-soft border-y border-line">
          {rows.map(({ item: r, next }) => {
            const overdue = r.active && next < today;
            return (
              <li key={r.id} className={cn("flex items-center gap-3 py-3", !r.active && "opacity-55")}>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: EVENT_TYPE_COLORS[RECURRING_TO_EVENT[r.recurring_type as RecurringType]] }}
                  aria-hidden
                />
                <Link href={`/recurring/${r.id}`} className="min-w-0 flex-1 hover:underline">
                  <span className="block truncate text-[14.5px] text-ink">{r.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {RECURRING_TYPES[r.recurring_type as RecurringType]} ·{" "}
                    {r.frequency === "custom" ? `Every ${r.interval_value} days` : FREQUENCIES[r.frequency as Frequency]}
                    {r.account_id && accounts.get(r.account_id) ? ` · ${accounts.get(r.account_id)!.name}` : ""}
                  </span>
                </Link>
                <span className="hidden md:block">{r.category_id ? <CategoryPill category={cats.byId.get(r.category_id)} /> : null}</span>
                <span className={cn("hidden w-28 text-right text-[13px] sm:block", overdue ? "text-brick" : "text-ink-2")}>
                  {r.active ? `${overdue ? "Due" : "Next"} ${formatShortDate(next)}` : "Inactive"}
                </span>
                <span className={cn("tabular w-24 text-right text-[14px]", r.recurring_type === "income" && "text-sage")}>
                  {r.amount_type !== "fixed" ? "~" : ""}
                  {formatMoney(r.expected_amount)}
                </span>
                <Switch checked={r.active} onChange={(v) => save.mutate({ id: r.id, values: { active: v } })} label={`${r.name} active`} />
              </li>
            );
          })}
        </ul>
      )}
      <RecurringFormDialog open={formOpen} onOpenChange={setFormOpen} />
    </Page>
  );
}

function Suggestions() {
  const { suggestions, isLoading, dismiss } = useRecurringSuggestions();
  const accounts = useAccountIndex();
  const [showAll, setShowAll] = useState(false);
  const [accepting, setAccepting] = useState<RecurringSuggestion | null>(null);
  if (isLoading || !suggestions.length) return null;
  const shown = showAll ? suggestions : suggestions.slice(0, 5);

  return (
    <section className="mb-8 rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <Sparkles className="size-4 text-accent" />
        <h2 className="text-[14px] font-medium">Suggested from your history</h2>
        <span className="text-[12.5px] text-ink-3">
          {suggestions.length} pattern{suggestions.length === 1 ? "" : "s"} that look recurring
        </span>
      </div>
      <ul className="divide-y divide-line-soft">
        {shown.map((sg) => (
          <li key={sg.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span className="size-2 shrink-0 rounded-full" style={{ background: EVENT_TYPE_COLORS[RECURRING_TO_EVENT[sg.recurringType]] }} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px]">{sg.name}</p>
              <p className="truncate text-[12px] text-ink-3">
                {RECURRING_TYPES[sg.recurringType]} · {FREQUENCIES[sg.frequency]} · seen {sg.occurrences}× · last {formatShortDate(sg.lastDate)}
                {sg.accountId && accounts.get(sg.accountId) ? ` · ${accounts.get(sg.accountId)!.name}` : ""}
              </p>
            </div>
            <span className="hidden w-28 text-right text-[13px] text-ink-2 sm:block">Next ~{formatShortDate(sg.nextDate)}</span>
            <span className={cn("tabular w-24 text-right text-[14px]", sg.recurringType === "income" && "text-sage")}>
              {sg.amountType !== "fixed" ? "~" : ""}
              {formatMoney(sg.amount)}
            </span>
            <div className="flex gap-1">
              <Button size="sm" onClick={() => setAccepting(sg)}>
                <Plus /> Add
              </Button>
              <Button size="sm" variant="quiet" onClick={() => dismiss(sg.key)} title="Hide this suggestion">
                Dismiss
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {suggestions.length > 5 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-full border-t border-line-soft px-4 py-2 text-left text-[12.5px] text-ink-2 hover:text-ink"
        >
          {showAll ? "Show fewer" : `Show all ${suggestions.length} suggestions`}
        </button>
      ) : null}
      <RecurringFormDialog open={accepting !== null} onOpenChange={(o) => !o && setAccepting(null)} suggestion={accepting ?? undefined} />
    </section>
  );
}
