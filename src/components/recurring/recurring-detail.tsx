"use client";

import { addDays } from "date-fns";
import { ArrowLeft, Link2, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { RecurringFormDialog } from "@/components/forms/recurring-form";
import { Page, SectionHeading } from "@/components/layout/app-shell";
import { MiniTransactionList } from "@/components/shared/mini-transaction-list";
import { CategoryPill } from "@/components/transactions/category-picker";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/dialog";
import { EmptyState, Skeleton } from "@/components/ui/skeleton";
import { buildCalendar } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { formatLongDate, monthlyFactor, todayISO, toISODate } from "@/lib/dates";
import { FREQUENCIES, RECURRING_TYPES, type Frequency, type RecurringOccurrence, type RecurringType } from "@/lib/domain";
import { formatMoney } from "@/lib/money";
import { useSetOccurrence } from "@/lib/queries/analytics";
import { qk, unwrap, useAccountIndex, useCategoryIndex, useDeleteRecurring, useRecurringItems, useSaveRecurring } from "@/lib/queries/reference";
import { TRANSACTION_SELECT, useTransactionsSimple } from "@/lib/queries/transactions";
import { getSupabase } from "@/lib/supabase/client";
import { useQuery } from "@tanstack/react-query";
import type { LedgerTransaction } from "@/lib/domain";
import { describePatterns, recurringPatterns, type MatchMode } from "@/lib/recurring-match";

export function RecurringDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data: items, isLoading } = useRecurringItems();
  const item = items?.find((r) => r.id === id);
  const accounts = useAccountIndex();
  const cats = useCategoryIndex();
  const save = useSaveRecurring();
  const del = useDeleteRecurring();
  const setOcc = useSetOccurrence();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);

  const history = useTransactionsSimple(["recurring-history", id], () =>
    getSupabase().from("transactions").select(TRANSACTION_SELECT).eq("recurring_item_id", id).order("transaction_date", { ascending: false }).limit(200),
  );
  const occurrences = useQuery({
    queryKey: [...qk.calendar, "occurrences", id],
    queryFn: () => unwrap<RecurringOccurrence[]>(getSupabase().from("recurring_occurrences").select("*").eq("recurring_item_id", id)),
  });

  const today = todayISO();
  const upcoming = useMemo(() => {
    if (!item || !history.data || !occurrences.data) return [];
    return buildCalendar({
      from: toISODate(addDays(new Date(), -30)),
      to: toISODate(addDays(new Date(), 400)),
      today,
      items: [{ ...item, active: true }],
      occurrences: occurrences.data,
      transactions: history.data as LedgerTransaction[],
      accounts: [],
      reminders: [],
    })
      .filter((e) => e.status !== "paid")
      .slice(0, 8);
  }, [item, history.data, occurrences.data, today]);

  const stats = useMemo(() => {
    const rows = history.data ?? [];
    const total = rows.reduce((s, t) => s + Math.abs(t.amount), 0);
    const lastYear = rows.filter((t) => t.transaction_date >= toISODate(addDays(new Date(), -365))).reduce((s, t) => s + Math.abs(t.amount), 0);
    return { count: rows.length, total, avg: rows.length ? total / rows.length : 0, lastYear };
  }, [history.data]);

  if (isLoading)
    return (
      <Page>
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  if (!item)
    return (
      <Page>
        <EmptyState
          title="Recurring item not found."
          action={
            <Link href="/recurring">
              <Button>Back to recurring</Button>
            </Link>
          }
        />
      </Page>
    );

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${item.name}”?`,
      body: "Linked transactions are kept but no longer marked recurring. Calendar projections are removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) del.mutate(item.id, { onSuccess: () => router.replace("/recurring") });
  };

  const account = item.account_id ? accounts.get(item.account_id) : undefined;
  const patterns = recurringPatterns(item);
  return (
    <Page>
      <Link href="/recurring" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink-2">
        <ArrowLeft className="size-3.5" /> Recurring
      </Link>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
            {RECURRING_TYPES[item.recurring_type as RecurringType]} ·{" "}
            {item.frequency === "custom" ? `Every ${item.interval_value} days` : FREQUENCIES[item.frequency as Frequency]}
            {!item.active ? " · Inactive" : ""}
          </p>
          <h1 className="mt-1 font-serif text-[28px] leading-tight">{item.name}</h1>
          {patterns.length ? (
            <p className="mt-1 text-[13px] text-ink-3">Matches transactions containing {describePatterns(patterns, item.match_mode as MatchMode)}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {patterns.length ? (
            <Button
              onClick={() => save.mutate({ id: item.id, values: {}, linkMatching: true })}
              disabled={save.isPending}
              title={`Link unlinked transactions containing ${describePatterns(patterns, item.match_mode as MatchMode)}`}
            >
              <Link2 /> Link matching
            </Button>
          ) : null}
          <Button onClick={() => setEditOpen(true)}>
            <Pencil /> Edit
          </Button>
          <Button variant="danger" onClick={remove}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
        <Stat label={`Expected (${item.amount_type})`} value={`${item.amount_type !== "fixed" ? "~" : ""}${formatMoney(item.expected_amount)}`} />
        <Stat label="Monthly equivalent" value={formatMoney(item.expected_amount * monthlyFactor(item.frequency, item.interval_value))} />
        <Stat
          label="Paid in last 12 months"
          value={formatMoney(stats.lastYear, { cents: false })}
          hint={`${stats.count} linked payments in total · avg ${formatMoney(stats.avg)}`}
        />
        <div>
          <dt className="text-[12px] text-ink-2">Account & category</dt>
          <dd className="mt-1 text-[14px]">{account?.name ?? "Any account"}</dd>
          <dd className="mt-1">
            {item.category_id ? <CategoryPill category={cats.byId.get(item.category_id)} /> : <span className="text-[12px] text-ink-3">No category</span>}
          </dd>
        </div>
      </dl>
      {item.notes ? <p className="mt-4 text-sm whitespace-pre-wrap text-ink-2">{item.notes}</p> : null}

      <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-2">
        <section>
          <SectionHeading>Upcoming</SectionHeading>
          {!item.active ? (
            <p className="text-sm text-ink-3">This item is inactive, so nothing is projected.</p>
          ) : !upcoming.length ? (
            <p className="text-sm text-ink-3">{history.isLoading ? "Loading…" : "No upcoming occurrences."}</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {upcoming.map((e) => (
                <li key={e.key} className={cn("flex items-center gap-3 py-2", e.status === "skipped" && "text-ink-3")}>
                  <span className="min-w-0 flex-1 text-[13.5px]">
                    <span className={cn(e.status === "skipped" && "line-through")}>{formatLongDate(e.date)}</span>
                    {e.status === "overdue" ? <span className="ml-2 text-[12px] text-brick">Not seen yet</span> : null}
                    {e.status === "skipped" ? <span className="ml-2 text-[12px]">Skipped</span> : null}
                  </span>
                  <span className="tabular text-[13.5px]">
                    {e.approximate ? "~" : ""}
                    {formatMoney(e.amount)}
                  </span>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={setOcc.isPending}
                    onClick={() => setOcc.mutate({ itemId: item.id, date: e.date, status: e.status === "skipped" ? "projected" : "skipped" })}
                  >
                    {e.status === "skipped" ? "Restore" : "Skip"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0">
          <SectionHeading
            actions={
              <Link href={`/transactions?recurring=yes&q=${encodeURIComponent(patterns[0] ?? item.name)}`} className="text-[12.5px] text-ink-2 hover:text-ink">
                Open in ledger
              </Link>
            }
          >
            Payment history
          </SectionHeading>
          <MiniTransactionList
            rows={history.data?.slice(0, 24)}
            loading={history.isLoading}
            empty="No linked transactions yet. Use “Link matching” or mark transactions as recurring."
          />
        </section>
      </div>
      <RecurringFormDialog open={editOpen} onOpenChange={setEditOpen} item={item} />
    </Page>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="pr-4">
      <dt className="text-[12px] text-ink-2">{label}</dt>
      <dd className="tabular mt-1 font-serif text-[22px] leading-none">{value}</dd>
      {hint ? <dd className="mt-1 text-[12px] text-ink-3">{hint}</dd> : null}
    </div>
  );
}
