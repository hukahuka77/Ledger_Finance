"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Switch } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { CategoryPicker, CategoryPill } from "@/components/transactions/category-picker";
import { stepDate, toISODate, todayISO, fromISODate } from "@/lib/dates";
import { AMOUNT_TYPE_OPTIONS, FREQUENCY_OPTIONS, RECURRING_TYPE_OPTIONS, type LedgerTransaction, type RecurringItem, type RecurringType } from "@/lib/domain";
import { formatMoney, parseMoney } from "@/lib/money";
import { formatShortDate } from "@/lib/dates";
import { cleanPatterns, MAX_MATCH_PATTERNS, recurringPatterns, type MatchMode } from "@/lib/recurring-match";
import { getSupabase } from "@/lib/supabase/client";
import { unwrap, useAccounts, useCategoryIndex, useSaveRecurring } from "@/lib/queries/reference";
import { useBulkUpdate, useUpdateTransaction } from "@/lib/queries/transactions";
import type { RecurringSuggestion } from "@/lib/recurring-detect";

type Draft = {
  name: string;
  patterns: string[];
  match_mode: MatchMode;
  recurring_type: RecurringType;
  expected_amount: string;
  amount_type: string;
  frequency: string;
  interval_value: string;
  next_expected_date: string;
  end_date: string;
  account_id: string;
  category_id: string | null;
  active: boolean;
  notes: string;
};

function fromItem(r: RecurringItem): Draft {
  return {
    name: r.name,
    patterns: recurringPatterns(r).length ? recurringPatterns(r) : [""],
    match_mode: (r.match_mode as MatchMode) ?? "any",
    recurring_type: r.recurring_type as RecurringType,
    expected_amount: r.expected_amount.toFixed(2),
    amount_type: r.amount_type,
    frequency: r.frequency,
    interval_value: String(r.interval_value),
    next_expected_date: r.next_expected_date,
    end_date: r.end_date ?? "",
    account_id: r.account_id ?? "",
    category_id: r.category_id,
    active: r.active,
    notes: r.notes ?? "",
  };
}

export function draftFromTransaction(t: LedgerTransaction, categoryName?: string): Draft {
  const type: RecurringType =
    t.transaction_type === "credit_card_payment"
      ? "credit_card_payment"
      : t.transaction_type === "transfer"
        ? "transfer"
        : t.amount > 0
          ? "income"
          : /subscri|stream/i.test(categoryName ?? "")
            ? "subscription"
            : "bill";
  let next = stepDate(fromISODate(t.transaction_date), "monthly");
  const today = fromISODate(todayISO());
  while (next < today) next = stepDate(next, "monthly");
  return {
    name: t.merchant_name,
    patterns: [t.merchant_name],
    match_mode: "any",
    recurring_type: type,
    expected_amount: Math.abs(t.amount).toFixed(2),
    amount_type: "fixed",
    frequency: "monthly",
    interval_value: "30",
    next_expected_date: toISODate(next),
    end_date: "",
    account_id: t.account_id,
    category_id: t.category_id,
    active: true,
    notes: "",
  };
}

function draftFromSuggestion(sg: RecurringSuggestion): Draft {
  return {
    name: sg.name,
    patterns: [sg.merchantPattern],
    match_mode: "any",
    recurring_type: sg.recurringType,
    expected_amount: sg.amount.toFixed(2),
    amount_type: sg.amountType,
    frequency: sg.frequency,
    interval_value: "30",
    next_expected_date: sg.nextDate,
    end_date: "",
    account_id: sg.accountId ?? "",
    category_id: sg.categoryId,
    active: true,
    notes: "",
  };
}

const EMPTY: Draft = {
  name: "",
  patterns: [""],
  match_mode: "any",
  recurring_type: "subscription",
  expected_amount: "",
  amount_type: "fixed",
  frequency: "monthly",
  interval_value: "30",
  next_expected_date: todayISO(),
  end_date: "",
  account_id: "",
  category_id: null,
  active: true,
  notes: "",
};

export function RecurringFormDialog({
  open,
  onOpenChange,
  item,
  fromTransaction,
  suggestion,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item?: RecurringItem;
  fromTransaction?: LedgerTransaction;
  /** A detected pattern from history; its transactions are linked on save. */
  suggestion?: RecurringSuggestion;
  onSaved?: (item: RecurringItem) => void;
}) {
  if (!open) return null;
  return (
    <RecurringFormInner
      key={item?.id ?? fromTransaction?.id ?? suggestion?.key ?? "new"}
      onOpenChange={onOpenChange}
      item={item}
      fromTransaction={fromTransaction}
      suggestion={suggestion}
      onSaved={onSaved}
    />
  );
}

function RecurringFormInner({
  onOpenChange,
  item,
  fromTransaction,
  suggestion,
  onSaved,
}: {
  onOpenChange: (o: boolean) => void;
  item?: RecurringItem;
  fromTransaction?: LedgerTransaction;
  suggestion?: RecurringSuggestion;
  onSaved?: (item: RecurringItem) => void;
}) {
  const cats = useCategoryIndex();
  const { data: accounts } = useAccounts();
  const save = useSaveRecurring();
  const updateTxn = useUpdateTransaction();
  const bulk = useBulkUpdate();
  const [d, setD] = useState<Draft>(() =>
    item
      ? fromItem(item)
      : suggestion
        ? draftFromSuggestion(suggestion)
        : fromTransaction
          ? draftFromTransaction(fromTransaction, cats.byId.get(fromTransaction.category_id ?? "")?.name)
          : EMPTY,
  );
  const [linkMatching, setLinkMatching] = useState(!item);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const amount = parseMoney(d.expected_amount);
  const interval = Number.parseInt(d.interval_value, 10);
  const errors = {
    name: !d.name.trim() ? "Name is required" : "",
    amount: amount === null || amount < 0 ? "Enter an amount" : "",
    date: !d.next_expected_date ? "Pick a date" : "",
    interval: d.frequency === "custom" && (!Number.isFinite(interval) || interval < 1 || interval > 3650) ? "1–3650 days" : "",
  };
  const valid = !Object.values(errors).some(Boolean);

  const patterns = cleanPatterns(d.patterns);
  const preview = useMatchPreview(patterns, d.match_mode, d.account_id || null, item?.id ?? null);
  const setPattern = (i: number, v: string) => set({ patterns: d.patterns.map((p, j) => (j === i ? v : p)) });
  const removePattern = (i: number) => set({ patterns: d.patterns.length > 1 ? d.patterns.filter((_, j) => j !== i) : [""] });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    save.mutate(
      {
        id: item?.id,
        linkMatching,
        values: {
          name: d.name.trim(),
          merchant_pattern: patterns[0] ?? null,
          match_patterns: patterns,
          match_mode: d.match_mode,
          recurring_type: d.recurring_type,
          expected_amount: Math.abs(amount!),
          amount_type: d.amount_type,
          frequency: d.frequency,
          interval_value: d.frequency === "custom" ? interval : 1,
          next_expected_date: d.next_expected_date,
          end_date: d.end_date || null,
          account_id: d.account_id || null,
          category_id: d.category_id,
          active: d.active,
          notes: d.notes.trim() || null,
        },
      },
      {
        onSuccess: ({ item: saved }) => {
          if (fromTransaction && fromTransaction.recurring_item_id !== saved.id) {
            updateTxn.mutate({ id: fromTransaction.id, patch: { recurring_item_id: saved.id } });
          }
          if (suggestion?.transactionIds.length) {
            bulk.mutate({ ids: suggestion.transactionIds, patch: { recurring_item_id: saved.id }, silent: true });
          }
          onSaved?.(saved);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={item ? "Edit recurring item" : "New recurring item"}
      description="Recurring items power the calendar and subscription totals."
      className="max-w-2xl"
    >
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="rec-name" className="sm:col-span-2">
          <Input id="rec-name" value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="Type" htmlFor="rec-type">
          <Select id="rec-type" value={d.recurring_type} onChange={(e) => set({ recurring_type: e.target.value as RecurringType })}>
            {RECURRING_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Expected amount" htmlFor="rec-amount" hint={errors.amount || undefined}>
            <Input
              id="rec-amount"
              inputMode="decimal"
              className="tabular"
              value={d.expected_amount}
              placeholder="0.00"
              onChange={(e) => set({ expected_amount: e.target.value })}
            />
          </Field>
          <Field label="Amount is" htmlFor="rec-amount-type">
            <Select id="rec-amount-type" value={d.amount_type} onChange={(e) => set({ amount_type: e.target.value })}>
              {AMOUNT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Frequency" htmlFor="rec-freq">
            <Select id="rec-freq" value={d.frequency} onChange={(e) => set({ frequency: e.target.value })}>
              {FREQUENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          {d.frequency === "custom" ? (
            <Field label="Every (days)" htmlFor="rec-interval" hint={errors.interval || undefined}>
              <Input id="rec-interval" inputMode="numeric" value={d.interval_value} onChange={(e) => set({ interval_value: e.target.value })} />
            </Field>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Next expected" htmlFor="rec-next">
            <Input id="rec-next" type="date" value={d.next_expected_date} onChange={(e) => set({ next_expected_date: e.target.value })} />
          </Field>
          <Field label="Ends (optional)" htmlFor="rec-end">
            <Input id="rec-end" type="date" value={d.end_date} onChange={(e) => set({ end_date: e.target.value })} />
          </Field>
        </div>
        <Field label="Account" htmlFor="rec-account">
          <Select id="rec-account" value={d.account_id} onChange={(e) => set({ account_id: e.target.value })}>
            <option value="">Any account</option>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.last_four ? ` ··${a.last_four}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Category">
          <CategoryPicker value={d.category_id} onChange={(id) => set({ category_id: id })}>
            <button type="button" className="flex h-8 w-full items-center rounded-md border border-line bg-surface px-2 hover:bg-hover">
              <CategoryPill category={d.category_id ? cats.byId.get(d.category_id) : null} />
            </button>
          </CategoryPicker>
        </Field>
        <fieldset className="grid gap-2 sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <legend className="text-[13px] font-medium text-ink">Match transactions containing</legend>
            {d.patterns.length > 1 ? (
              <Segmented
                ariaLabel="How phrases combine"
                size="sm"
                value={d.match_mode}
                onChange={(v) => set({ match_mode: v })}
                options={[
                  { value: "any", label: "Any phrase" },
                  { value: "all", label: "All phrases" },
                ]}
              />
            ) : null}
          </div>
          {d.patterns.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              {i > 0 ? (
                <span className="w-8 shrink-0 text-right text-[12px] font-medium text-ink-3 uppercase">{d.match_mode === "all" ? "and" : "or"}</span>
              ) : null}
              <Input
                id={i === 0 ? "rec-pattern" : `rec-pattern-${i}`}
                aria-label={`Match phrase ${i + 1}`}
                value={p}
                maxLength={200}
                placeholder={i === 0 ? "e.g. ATT" : "e.g. phone"}
                className={i === 0 && d.patterns.length > 1 ? "ml-10" : undefined}
                onChange={(e) => setPattern(i, e.target.value)}
              />
              {d.patterns.length > 1 || p ? (
                <button
                  type="button"
                  aria-label={`Remove phrase ${i + 1}`}
                  onClick={() => removePattern(i)}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {d.patterns.length < MAX_MATCH_PATTERNS ? (
              <Button type="button" size="sm" variant="quiet" onClick={() => set({ patterns: [...d.patterns, ""] })}>
                <Plus /> Add phrase
              </Button>
            ) : (
              <span />
            )}
            <MatchPreview state={preview} hasPatterns={patterns.length > 0} />
          </div>
          <p className="text-[12px] text-ink-3">
            A phrase matches when it appears anywhere in the merchant name or the bank&apos;s description (capital letters don&apos;t matter). With several
            phrases, choose whether any one is enough or all of them must appear. New transactions from bank sync and imports are linked automatically.
          </p>
        </fieldset>
        <Field label="Notes" htmlFor="rec-notes" className="sm:col-span-2">
          <Textarea id="rec-notes" value={d.notes} maxLength={2000} className="min-h-16" onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <div className="flex flex-wrap items-center gap-5 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <Switch checked={d.active} onChange={(v) => set({ active: v })} label="Active" /> Active
          </label>
          {patterns.length ? (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Checkbox checked={linkMatching} onChange={setLinkMatching} label="Link matching transactions" />
              {preview.data
                ? `Link ${preview.data.unlinked} unlinked matching transaction${preview.data.unlinked === 1 ? "" : "s"}`
                : "Link existing matching transactions"}
            </label>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line-soft pt-4 sm:col-span-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || save.isPending}>
            {save.isPending ? "Saving…" : item ? "Save changes" : "Create recurring item"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Preview = { total: number; unlinked: number; linked_elsewhere: number; sample: { date: string; merchant: string; amount: number }[] };

/** Live count of the transactions the current phrases would match (debounced). */
function useMatchPreview(patterns: string[], mode: MatchMode, accountId: string | null, itemId: string | null) {
  const key = JSON.stringify([patterns, mode, accountId]);
  const [debounced, setDebounced] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(key), 350);
    return () => clearTimeout(t);
  }, [key]);
  const [ps, m, acct] = JSON.parse(debounced) as [string[], MatchMode, string | null];
  return useQuery({
    queryKey: ["recurring-match-preview", debounced, itemId],
    enabled: ps.length > 0,
    staleTime: 30_000,
    queryFn: () =>
      unwrap<Preview>(
        getSupabase().rpc("preview_recurring_matches", {
          p_patterns: ps,
          p_mode: m,
          ...(acct ? { p_account_id: acct } : {}),
          ...(itemId ? { p_recurring_item_id: itemId } : {}),
        }) as unknown as PromiseLike<{ data: Preview; error: unknown }>,
      ),
  });
}

function MatchPreview({ state, hasPatterns }: { state: { data?: Preview; isFetching: boolean; isError: boolean }; hasPatterns: boolean }) {
  if (!hasPatterns) return <span className="text-[12.5px] text-ink-3">Add a phrase to see what it matches.</span>;
  if (state.isError) return <span className="text-[12.5px] text-brick">Couldn&apos;t check matches.</span>;
  if (!state.data) return <span className="text-[12.5px] text-ink-3">Checking matches…</span>;
  const { total, linked_elsewhere, sample } = state.data;
  const latest = sample[0];
  return (
    <span className={`text-right text-[12.5px] ${total ? "text-ink-2" : "text-brick"}`} aria-live="polite">
      {total ? (
        <>
          Matches <b className="font-semibold text-ink">{total}</b> transaction{total === 1 ? "" : "s"}
          {linked_elsewhere ? ` (${linked_elsewhere} already linked to another item)` : ""}
          {latest ? ` · latest ${latest.merchant.slice(0, 28)} ${formatMoney(Math.abs(latest.amount))} on ${formatShortDate(latest.date)}` : ""}
        </>
      ) : (
        "No transactions match yet"
      )}
      {state.isFetching ? " …" : ""}
    </span>
  );
}
