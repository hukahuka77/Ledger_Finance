"use client";

import { addDays, addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Pencil, Plus, Repeat, SkipForward, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useSyncExternalStore } from "react";
import { AccountFormDialog } from "@/components/accounts/account-form";
import { ReminderDialog } from "@/components/calendar/reminder-form";
import { RecurringFormDialog } from "@/components/forms/recurring-form";
import { CategoryPill } from "@/components/transactions/category-picker";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog, useConfirm } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import type { CalendarEvent } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { formatLongDate, fromISODate, todayISO, toISODate } from "@/lib/dates";
import { EVENT_TYPE_COLORS, EVENT_TYPES, FREQUENCIES, type CalendarReminder, type EventType, type Frequency } from "@/lib/domain";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { formatMoney } from "@/lib/money";
import { useCalendarEvents, useDeleteReminder, useSaveReminder, useSetOccurrence } from "@/lib/queries/analytics";
import { useAccountIndex, useCategoryIndex, useRecurringIndex } from "@/lib/queries/reference";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_LABEL = { projected: "Expected", paid: "Paid", overdue: "Not seen yet", skipped: "Skipped" } as const;
const HIDDEN_KEY = "ledger.calendar.hidden";

const hiddenListeners = new Set<() => void>();
/** Fallback when storage is unavailable, so the filter still works for this visit. */
let hiddenInMemory = "[]";
const readHidden = () => {
  try {
    return localStorage.getItem(HIDDEN_KEY) ?? hiddenInMemory;
  } catch {
    return hiddenInMemory;
  }
};

/** Event types the viewer has unticked, remembered in this browser. */
function useHiddenTypes() {
  const raw = useSyncExternalStore(
    (cb) => {
      hiddenListeners.add(cb);
      return () => hiddenListeners.delete(cb);
    },
    readHidden,
    () => "[]",
  );
  const hidden = useMemo(() => {
    try {
      return new Set((JSON.parse(raw) as string[]).filter((t): t is EventType => t in EVENT_TYPES));
    } catch {
      return new Set<EventType>();
    }
  }, [raw]);
  const toggle = (t: EventType) => {
    const next = new Set(hidden);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    hiddenInMemory = JSON.stringify([...next]);
    try {
      localStorage.setItem(HIDDEN_KEY, hiddenInMemory);
    } catch {
      /* not remembered across visits */
    }
    hiddenListeners.forEach((cb) => cb());
  };
  return { hidden, toggle };
}

export function CalendarView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const monthParam = params.get("month");
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? fromISODate(`${monthParam}-01`) : startOfMonth(new Date());
  const view = (params.get("view") ?? (isMobile ? "agenda" : "month")) as "month" | "agenda";

  const gridFrom = startOfWeek(startOfMonth(month));
  const gridTo = endOfWeek(endOfMonth(month));
  const agendaFrom = monthParam ? startOfMonth(month) : new Date();
  const agendaTo = monthParam ? endOfMonth(month) : addDays(new Date(), 30);
  const from = toISODate(view === "month" ? gridFrom : agendaFrom);
  const to = toISODate(view === "month" ? gridTo : agendaTo);
  const { events: allEvents, reminders, isLoading } = useCalendarEvents(from, to);
  const { hidden, toggle } = useHiddenTypes();
  const events = useMemo(() => allEvents?.filter((e) => !hidden.has(e.eventType)), [allEvents, hidden]);

  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const [reminderFor, setReminderFor] = useState<string | null>(null);
  const today = todayISO();

  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    Object.entries(patch).forEach(([k, v]) => (v ? sp.set(k, v) : sp.delete(k)));
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };
  const go = (delta: number) => set({ month: format(addMonths(month, delta), "yyyy-MM") });

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    (events ?? []).forEach((e) => m.set(e.date, [...(m.get(e.date) ?? []), e]));
    return m;
  }, [events]);

  const monthKey = format(month, "yyyy-MM");
  const summary = (() => {
    const inMonth = (events ?? []).filter((e) => e.date.slice(0, 7) === monthKey && !e.inflow);
    const paid = inMonth.filter((e) => e.status === "paid").reduce((s, e) => s + e.amount, 0);
    const expected = inMonth.filter((e) => e.status === "projected" || e.status === "overdue").reduce((s, e) => s + e.amount, 0);
    return { paid, expected };
  })();

  const days: Date[] = [];
  for (let d = gridFrom; d <= gridTo; d = addDays(d, 1)) days.push(d);

  const title = view === "agenda" && !monthParam ? "Next 30 days" : format(month, "MMMM yyyy");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <h1 className="mr-2 font-serif text-[24px] leading-none">{title}</h1>
        <div className="flex items-center">
          <IconButton label="Previous month" variant="quiet" onClick={() => go(-1)}>
            <ChevronLeft />
          </IconButton>
          <Button size="sm" variant="quiet" onClick={() => set({ month: null })}>
            Today
          </Button>
          <IconButton label="Next month" variant="quiet" onClick={() => go(1)}>
            <ChevronRight />
          </IconButton>
        </div>
        <p className="tabular hidden text-[12.5px] text-ink-2 lg:block">
          {format(month, "MMMM")}: {formatMoney(summary.paid, { cents: false })} paid · ~{formatMoney(summary.expected, { cents: false })} still expected
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            size="sm"
            ariaLabel="View"
            value={view}
            onChange={(v) => set({ view: v })}
            options={[
              { value: "month", label: "Month" },
              { value: "agenda", label: "Agenda" },
            ]}
          />
          <Button size="sm" onClick={() => setReminderFor(today)}>
            <Plus /> Reminder
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft px-4 py-2 text-[12px] text-ink-2 sm:px-6">
        {(Object.keys(EVENT_TYPES) as EventType[]).map((t) => {
          const on = !hidden.has(t);
          return (
            <button
              key={t}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(t)}
              title={on ? `Hide ${EVENT_TYPES[t].toLowerCase()}s` : `Show ${EVENT_TYPES[t].toLowerCase()}s`}
              className={cn("-mx-1 flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-hover", !on && "text-ink-3")}
            >
              <span
                className="inline-flex size-3.5 items-center justify-center rounded-[3px] border"
                style={on ? { background: EVENT_TYPE_COLORS[t], borderColor: EVENT_TYPE_COLORS[t] } : { borderColor: "#cbc6bc" }}
              >
                {on ? <Check className="size-2.5 text-white" strokeWidth={3.5} /> : null}
              </span>
              {EVENT_TYPES[t]}
            </button>
          );
        })}
        <span className="flex items-center gap-1.5 sm:ml-auto">
          <span className="inline-block h-3 w-5 rounded-[3px] border border-dashed border-ink-3" /> Expected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-5 rounded-[3px] bg-sidebar ring-1 ring-line" /> Paid
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-6">
            <Skeleton className="h-[480px] w-full" />
          </div>
        ) : view === "month" ? (
          <div className="grid min-w-[720px] grid-cols-7">
            {WEEKDAYS.map((w) => (
              <div key={w} className="border-b border-line px-2 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
                {w}
              </div>
            ))}
            {days.map((d) => {
              const iso = toISODate(d);
              const list = byDay.get(iso) ?? [];
              const inMonth = isSameMonth(d, month);
              return (
                <div
                  key={iso}
                  className={cn(
                    "group relative min-h-[118px] border-r border-b border-line-soft p-1.5 [&:nth-child(7n)]:border-r-0",
                    !inMonth && "bg-sidebar/40",
                  )}
                  onDoubleClick={() => setReminderFor(iso)}
                >
                  <div className="flex items-center justify-between px-0.5">
                    <span
                      className={cn(
                        "tabular inline-flex size-6 items-center justify-center rounded-full text-[12.5px]",
                        iso === today ? "bg-accent font-medium text-white" : inMonth ? "text-ink" : "text-ink-3",
                      )}
                    >
                      {d.getDate()}
                    </span>
                    <button
                      type="button"
                      aria-label={`Add reminder on ${iso}`}
                      onClick={() => setReminderFor(iso)}
                      className="rounded p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus:opacity-100"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {list.slice(0, 4).map((e) => (
                      <li key={e.key}>
                        <EventChip event={e} onClick={() => setSelected(e)} />
                      </li>
                    ))}
                  </ul>
                  {list.length > 4 ? (
                    <button
                      type="button"
                      onClick={() => set({ view: "agenda", month: format(month, "yyyy-MM") })}
                      className="mt-0.5 px-1 text-[11px] text-ink-2 hover:text-ink"
                    >
                      +{list.length - 4} more
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <Agenda events={events ?? []} onSelect={setSelected} />
        )}
      </div>

      <EventDialog event={selected} onClose={() => setSelected(null)} reminders={reminders} />
      <ReminderDialog open={reminderFor !== null} onOpenChange={(o) => !o && setReminderFor(null)} date={reminderFor ?? undefined} />
    </div>
  );
}

function EventChip({ event: e, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const projected = e.status === "projected" || e.status === "overdue";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${e.title} · ${STATUS_LABEL[e.status]} · ${formatMoney(e.amount)}`}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-[4px] px-1.5 py-[3px] text-left text-[11.5px] leading-tight transition-colors",
        e.status === "paid" && "bg-sidebar text-ink-2 ring-1 ring-line-soft hover:bg-hover",
        projected && "border border-dashed border-[#cfc9be] text-ink hover:bg-hover",
        e.status === "overdue" && "border-brick/50",
        e.status === "skipped" && "text-ink-3 line-through hover:bg-hover",
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: EVENT_TYPE_COLORS[e.eventType] }} />
      <span className="min-w-0 flex-1 truncate">{e.title}</span>
      <span className="tabular shrink-0 text-ink-2">
        {projected && e.approximate ? "~" : ""}
        {formatMoney(e.amount, { cents: false })}
      </span>
      {e.status === "paid" ? <Check className="size-3 shrink-0 text-sage" /> : null}
    </button>
  );
}

function Agenda({ events, onSelect }: { events: CalendarEvent[]; onSelect: (e: CalendarEvent) => void }) {
  const groups = new Map<string, CalendarEvent[]>();
  events.forEach((e) => groups.set(e.date, [...(groups.get(e.date) ?? []), e]));
  if (!events.length)
    return (
      <p className="px-6 py-16 text-center text-sm text-ink-3">
        No bills, subscriptions or reminders in this range. Add recurring items or card due dates to see them here.
      </p>
    );
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:px-6">
      {[...groups.entries()].map(([date, list]) => (
        <section key={date} className="border-b border-line-soft py-3">
          <h2 className="mb-1.5 text-[11.5px] font-semibold tracking-[0.08em] text-ink-2 uppercase">{format(fromISODate(date), "EEE, MMM d")}</h2>
          <ul>
            {list.map((e) => (
              <li key={e.key}>
                <button
                  type="button"
                  onClick={() => onSelect(e)}
                  className="-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover/60"
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: EVENT_TYPE_COLORS[e.eventType] }} />
                  <span className={cn("min-w-0 flex-1 truncate text-[14px]", e.status === "skipped" && "text-ink-3 line-through")}>{e.title}</span>
                  <span className={cn("text-[12px]", e.status === "paid" ? "text-sage" : e.status === "overdue" ? "text-brick" : "text-ink-3")}>
                    {STATUS_LABEL[e.status]}
                  </span>
                  <span className={cn("tabular w-24 text-right text-[14px]", e.inflow && "text-sage")}>
                    {e.status !== "paid" && e.approximate ? "~" : ""}
                    {formatMoney(e.amount)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EventDialog({ event: e, onClose, reminders }: { event: CalendarEvent | null; onClose: () => void; reminders: CalendarReminder[] }) {
  const recurring = useRecurringIndex();
  const accounts = useAccountIndex();
  const cats = useCategoryIndex();
  const setOcc = useSetOccurrence();
  const saveReminder = useSaveReminder();
  const delReminder = useDeleteReminder();
  const confirm = useConfirm();
  const [editRecurring, setEditRecurring] = useState(false);
  const [editAccount, setEditAccount] = useState(false);
  const [editReminder, setEditReminder] = useState(false);
  if (!e) return null;

  const item = e.recurringItemId ? recurring.get(e.recurringItemId) : undefined;
  const account = e.accountId ? accounts.get(e.accountId) : undefined;
  const autopay = e.autopayAccountId ? accounts.get(e.autopayAccountId) : undefined;
  const reminder = e.reminderId ? reminders.find((r) => r.id === e.reminderId) : undefined;

  return (
    <>
      <Dialog
        open={!editRecurring && !editAccount && !editReminder}
        onOpenChange={(o) => !o && onClose()}
        title={e.title}
        description={`${STATUS_LABEL[e.status]} · ${formatLongDate(e.date)}`}
      >
        <dl className="grid grid-cols-[120px_1fr] gap-y-2.5 text-sm">
          <dt className="text-ink-2">Amount</dt>
          <dd className="tabular font-serif text-xl leading-none">
            {e.status !== "paid" && e.approximate ? "~" : ""}
            {formatMoney(e.amount)}
          </dd>
          <dt className="text-ink-2">Type</dt>
          <dd>{EVENT_TYPES[e.eventType]}</dd>
          {e.expectedDate && e.expectedDate !== e.date ? (
            <>
              <dt className="text-ink-2">Expected</dt>
              <dd>{formatLongDate(e.expectedDate)}</dd>
            </>
          ) : null}
          {account ? (
            <>
              <dt className="text-ink-2">Account</dt>
              <dd>{account.name}</dd>
            </>
          ) : null}
          {e.categoryId ? (
            <>
              <dt className="text-ink-2">Category</dt>
              <dd>
                <CategoryPill category={cats.byId.get(e.categoryId)} />
              </dd>
            </>
          ) : null}
          {item ? (
            <>
              <dt className="text-ink-2">Frequency</dt>
              <dd>{item.frequency === "custom" ? `Every ${item.interval_value} days` : FREQUENCIES[item.frequency as Frequency]}</dd>
            </>
          ) : null}
          {e.source === "card" && account?.statement_balance !== null && account?.statement_balance !== undefined ? (
            <>
              <dt className="text-ink-2">Statement</dt>
              <dd>
                {formatMoney(account.statement_balance)}
                {account.last_statement_date ? <span className="text-ink-3"> · issued {formatLongDate(account.last_statement_date)}</span> : null}
              </dd>
            </>
          ) : null}
          {e.source === "card" && account?.minimum_payment !== null && account?.minimum_payment !== undefined ? (
            <>
              <dt className="text-ink-2">Minimum</dt>
              <dd>{formatMoney(account.minimum_payment)}</dd>
            </>
          ) : null}
          {e.source === "card" ? (
            <>
              <dt className="text-ink-2">Autopay</dt>
              <dd>{autopay ? `On · from ${autopay.name}` : account?.autopay_enabled ? "On" : "Off"}</dd>
            </>
          ) : null}
        </dl>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line-soft pt-4">
          {e.transactionId ? (
            <Link href={`/transactions?id=${e.transactionId}`}>
              <Button size="sm">
                <ExternalLink /> View transaction
              </Button>
            </Link>
          ) : null}
          {item ? (
            <>
              <Button size="sm" onClick={() => setEditRecurring(true)}>
                <Pencil /> Edit recurring item
              </Button>
              <Link href={`/recurring/${item.id}`}>
                <Button size="sm" variant="quiet">
                  <Repeat /> History
                </Button>
              </Link>
              {e.status !== "paid" && e.expectedDate ? (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() =>
                    setOcc.mutate({ itemId: item.id, date: e.expectedDate!, status: e.status === "skipped" ? "projected" : "skipped" }, { onSuccess: onClose })
                  }
                >
                  {e.status === "skipped" ? <Undo2 /> : <SkipForward />} {e.status === "skipped" ? "Restore" : "Skip this one"}
                </Button>
              ) : null}
            </>
          ) : null}
          {e.source === "card" && account ? (
            <Button size="sm" onClick={() => setEditAccount(true)}>
              <Pencil /> Edit card details
            </Button>
          ) : null}
          {reminder ? (
            <>
              <Button size="sm" onClick={() => saveReminder.mutate({ id: reminder.id, values: { completed: e.status !== "paid" } }, { onSuccess: onClose })}>
                <Check /> {e.status === "paid" ? "Mark not done" : "Mark done"}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setEditReminder(true)}>
                <Pencil /> Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (await confirm({ title: "Delete this reminder?", confirmLabel: "Delete", danger: true }))
                    delReminder.mutate(reminder.id, { onSuccess: onClose });
                }}
              >
                <Trash2 /> Delete
              </Button>
            </>
          ) : null}
        </div>
      </Dialog>
      <RecurringFormDialog
        open={editRecurring}
        onOpenChange={(o) => {
          setEditRecurring(o);
          if (!o) onClose();
        }}
        item={item}
      />
      <AccountFormDialog
        open={editAccount}
        onOpenChange={(o) => {
          setEditAccount(o);
          if (!o) onClose();
        }}
        account={account}
      />
      <ReminderDialog
        open={editReminder}
        onOpenChange={(o) => {
          setEditReminder(o);
          if (!o) onClose();
        }}
        reminder={reminder}
      />
    </>
  );
}
