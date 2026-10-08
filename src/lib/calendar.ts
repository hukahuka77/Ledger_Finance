/**
 * Calendar projection engine (pure). Projects recurring schedules and credit-card
 * due dates into a date range, then reconciles them with real transactions so a
 * matched charge appears once — as the actual — never as both.
 */
import { addDays, addMonths, differenceInCalendarDays, getDaysInMonth } from "date-fns";
import { fromISODate, matchWindowDays, toISODate } from "@/lib/dates";
import type { Account, CalendarReminder, EventType, RecurringItem, RecurringOccurrence, RecurringType, Transaction } from "@/lib/domain";
import { RECURRING_TO_EVENT } from "@/lib/domain";

export type EventStatus = "projected" | "paid" | "overdue" | "skipped";

export interface CalendarEvent {
  key: string;
  date: string;
  title: string;
  /** Positive magnitude. */
  amount: number;
  approximate: boolean;
  status: EventStatus;
  eventType: EventType;
  source: "recurring" | "card" | "reminder";
  recurringItemId?: string;
  transactionId?: string;
  accountId?: string | null;
  categoryId?: string | null;
  expectedDate?: string;
  reminderId?: string;
  autopayAccountId?: string | null;
  inflow?: boolean;
}

export interface CalendarInput {
  from: string;
  to: string;
  today: string;
  items: RecurringItem[];
  occurrences: RecurringOccurrence[];
  /** Transactions linked to recurring items, plus card payments, around the range. */
  transactions: Pick<Transaction, "id" | "transaction_date" | "amount" | "recurring_item_id" | "account_id" | "transaction_type" | "merchant_name">[];
  accounts: Account[];
  reminders: CalendarReminder[];
}

const OVERDUE_DAYS = 21;

/** The k-th occurrence relative to the anchor (k may be negative). Computed from the anchor to avoid month-end drift. */
function nth(anchor: Date, frequency: string, intervalValue: number, k: number): Date {
  switch (frequency) {
    case "weekly":
      return addDays(anchor, 7 * k);
    case "biweekly":
      return addDays(anchor, 14 * k);
    case "monthly":
      return addMonths(anchor, k);
    case "quarterly":
      return addMonths(anchor, 3 * k);
    case "semiannual":
      return addMonths(anchor, 6 * k);
    case "annual":
      return addMonths(anchor, 12 * k);
    default:
      return addDays(anchor, Math.max(1, intervalValue) * k);
  }
}

/** Every scheduled date of an item within [from, to], honouring its end date. */
export function scheduleDates(item: RecurringItem, from: string, to: string): string[] {
  const anchor = fromISODate(item.next_expected_date);
  const start = fromISODate(from);
  const end = fromISODate(to);
  const stop = item.end_date ? fromISODate(item.end_date) : null;
  const out: string[] = [];
  let k = 0;
  let guard = 0;
  while (nth(anchor, item.frequency, item.interval_value, k) > start && guard++ < 5000) k--;
  guard = 0;
  for (let d = nth(anchor, item.frequency, item.interval_value, k); d <= end && guard++ < 5000; d = nth(anchor, item.frequency, item.interval_value, ++k)) {
    if (d >= start && (!stop || d <= stop)) out.push(toISODate(d));
  }
  return out;
}

export function buildCalendar(input: CalendarInput): CalendarEvent[] {
  const { from, to, today } = input;
  const events: CalendarEvent[] = [];
  const todayD = fromISODate(today);

  const byItem = new Map<string, CalendarInput["transactions"]>();
  for (const t of input.transactions) {
    if (!t.recurring_item_id) continue;
    byItem.set(t.recurring_item_id, [...(byItem.get(t.recurring_item_id) ?? []), t]);
  }
  const overrides = new Map(input.occurrences.map((o) => [`${o.recurring_item_id}|${o.expected_date}`, o]));

  for (const item of input.items) {
    if (!item.active) continue;
    const eventType = RECURRING_TO_EVENT[item.recurring_type as RecurringType] ?? "other";
    const window = matchWindowDays(item.frequency, item.interval_value);
    const linked = [...(byItem.get(item.id) ?? [])].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
    const used = new Set<string>();
    const approximate = item.amount_type !== "fixed";
    const inflow = item.recurring_type === "income";

    // Widen the schedule window so matches just outside the view still reconcile.
    const dates = scheduleDates(item, toISODate(addDays(fromISODate(from), -window)), toISODate(addDays(fromISODate(to), window)));
    for (const date of dates) {
      const ov = overrides.get(`${item.id}|${date}`);
      const d = fromISODate(date);
      let match = ov?.transaction_id ? linked.find((t) => t.id === ov.transaction_id) : undefined;
      if (!match) {
        match = linked
          .filter((t) => !used.has(t.id) && Math.abs(differenceInCalendarDays(fromISODate(t.transaction_date), d)) <= window)
          .sort(
            (a, b) =>
              Math.abs(differenceInCalendarDays(fromISODate(a.transaction_date), d)) - Math.abs(differenceInCalendarDays(fromISODate(b.transaction_date), d)),
          )[0];
      }
      if (match) {
        used.add(match.id);
        continue; // the actual transaction is emitted below
      }
      if (date < from || date > to) continue;
      const base = {
        key: `r:${item.id}:${date}`,
        date,
        title: item.name,
        amount: Number(ov?.expected_amount ?? item.expected_amount),
        approximate,
        eventType,
        source: "recurring" as const,
        recurringItemId: item.id,
        accountId: item.account_id,
        categoryId: item.category_id,
        expectedDate: date,
        inflow,
      };
      if (ov?.status === "skipped") {
        events.push({ ...base, status: "skipped" });
      } else if (d < todayD) {
        // Only recent misses are interesting; older gaps are history, not obligations.
        if (differenceInCalendarDays(todayD, d) <= OVERDUE_DAYS && d >= fromISODate(item.created_at.slice(0, 10))) events.push({ ...base, status: "overdue" });
      } else {
        events.push({ ...base, status: "projected" });
      }
    }

    for (const t of linked) {
      if (t.transaction_date < from || t.transaction_date > to) continue;
      events.push({
        key: `t:${t.id}`,
        date: t.transaction_date,
        title: item.name,
        amount: Math.abs(t.amount),
        approximate: false,
        status: "paid",
        eventType,
        source: "recurring",
        recurringItemId: item.id,
        transactionId: t.id,
        accountId: t.account_id,
        categoryId: item.category_id,
        inflow: t.amount > 0,
      });
    }
  }

  // Credit-card payment due dates. With statement data from the bank (Plaid Liabilities) the next
  // due date and statement balance are exact; other months are projected from the due day.
  const cards = input.accounts.filter((a) => a.active && a.account_type === "credit_card" && (a.payment_due_day || a.next_payment_due_date));
  if (cards.length) {
    let cursor = new Date(fromISODate(from).getFullYear(), fromISODate(from).getMonth(), 1);
    const end = fromISODate(to);
    while (cursor <= end) {
      for (const card of cards) {
        const next = card.next_payment_due_date;
        const isNextMonth = next ? next.slice(0, 7) === toISODate(cursor).slice(0, 7) : false;
        if (!isNextMonth && !card.payment_due_day) continue;
        const due = isNextMonth
          ? fromISODate(next!)
          : new Date(cursor.getFullYear(), cursor.getMonth(), Math.min(card.payment_due_day!, getDaysInMonth(cursor)));
        const date = toISODate(due);
        if (date < from || date > to) continue;
        const paidTxn = input.transactions.find(
          (t) =>
            t.account_id === card.id &&
            t.transaction_type === "credit_card_payment" &&
            t.amount > 0 &&
            differenceInCalendarDays(due, fromISODate(t.transaction_date)) <= 25 &&
            differenceInCalendarDays(fromISODate(t.transaction_date), due) <= 3,
        );
        const statement = card.statement_balance === null ? null : Number(card.statement_balance);
        let amount: number;
        let approximate: boolean;
        let status: EventStatus;
        if (isNextMonth) {
          // The bank reports a payment made since this statement that covers it (e.g. autopay already ran).
          const coveredByBank =
            card.last_payment_date !== null &&
            card.last_statement_date !== null &&
            card.last_payment_date >= card.last_statement_date &&
            Number(card.last_payment_amount ?? 0) >= (statement ?? Infinity) - 0.01;
          const nothingOwed = statement !== null && statement <= 0;
          amount = paidTxn
            ? Math.abs(paidTxn.amount)
            : coveredByBank
              ? Number(card.last_payment_amount)
              : Math.max(0, statement ?? Number(card.current_balance ?? 0));
          approximate = !paidTxn && !coveredByBank && statement === null;
          status = paidTxn || coveredByBank || nothingOwed ? "paid" : card.is_overdue ? "overdue" : due < todayD ? "overdue" : "projected";
        } else {
          const later = next !== null && date > next;
          // Beyond the next due date the statement hasn't been issued yet: estimate from the current balance.
          const owed = later ? Number(card.current_balance ?? 0) : Number(statement ?? card.current_balance ?? 0);
          amount = paidTxn ? Math.abs(paidTxn.amount) : Math.max(0, owed);
          approximate = !paidTxn && (later || statement === null);
          status = paidTxn ? "paid" : due < todayD ? (differenceInCalendarDays(todayD, due) <= OVERDUE_DAYS ? "overdue" : "paid") : "projected";
        }
        events.push({
          key: `c:${card.id}:${date}`,
          date,
          title: `${card.name} payment due`,
          amount,
          approximate,
          status,
          eventType: "credit_card_payment",
          source: "card",
          accountId: card.id,
          transactionId: paidTxn?.id,
          autopayAccountId: card.autopay_enabled ? card.autopay_account_id : null,
        });
      }
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }

  for (const r of input.reminders) {
    if (r.reminder_date < from || r.reminder_date > to) continue;
    events.push({
      key: `m:${r.id}`,
      date: r.reminder_date,
      title: r.title,
      amount: Number(r.amount ?? 0),
      approximate: false,
      status: r.completed ? "paid" : fromISODate(r.reminder_date) < todayD ? "overdue" : "projected",
      eventType: r.event_type as EventType,
      source: "reminder",
      reminderId: r.id,
      accountId: r.account_id,
    });
  }

  return events.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

/** First upcoming (unmatched, not skipped) expected date for an item. */
export function nextDueDate(item: RecurringItem, linked: { transaction_date: string; id: string }[], today: string): string {
  const horizon = toISODate(addDays(fromISODate(today), 800));
  const window = matchWindowDays(item.frequency, item.interval_value);
  const start = toISODate(addDays(fromISODate(today), -window));
  for (const d of scheduleDates(item, start, horizon)) {
    const hit = linked.some((t) => Math.abs(differenceInCalendarDays(fromISODate(t.transaction_date), fromISODate(d))) <= window);
    if (!hit && d >= today) return d;
  }
  return item.next_expected_date;
}
