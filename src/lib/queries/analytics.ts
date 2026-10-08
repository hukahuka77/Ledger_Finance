"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays } from "date-fns";
import { toast } from "sonner";
import { buildCalendar, type CalendarEvent } from "@/lib/calendar";
import type { TablesInsert, TablesUpdate } from "@/lib/database.types";
import { fromISODate, toISODate, todayISO } from "@/lib/dates";
import type { CalendarReminder, LedgerTransaction, RecurringOccurrence, Transaction } from "@/lib/domain";
import { reportError } from "@/lib/errors";
import { qk, unwrap, useAccounts, useRecurringItems } from "@/lib/queries/reference";
import { TRANSACTION_SELECT } from "@/lib/queries/transactions";
import { getSupabase } from "@/lib/supabase/client";

export function useCashflow(from: string, to: string, accountId?: string) {
  return useQuery({
    queryKey: [...qk.analytics, "cashflow", from, to, accountId ?? null],
    queryFn: async () => {
      const rows = await unwrap<{ spending: number; income: number; transaction_count: number }[]>(
        getSupabase().rpc("cashflow_summary", { p_start: from, p_end: to, p_account_id: accountId }),
      );
      return rows[0] ?? { spending: 0, income: 0, transaction_count: 0 };
    },
  });
}

export function useSpendingByCategory(from: string, to: string, accountId?: string) {
  return useQuery({
    queryKey: [...qk.analytics, "by-category", from, to, accountId ?? null],
    queryFn: () =>
      unwrap<{ category_id: string | null; amount: number; transaction_count: number }[]>(
        getSupabase().rpc("spending_by_category", { p_start: from, p_end: to, p_account_id: accountId }),
      ),
  });
}

export function useMonthlyCashflow(end: string, months = 12) {
  return useQuery({
    queryKey: [...qk.analytics, "monthly", end, months],
    queryFn: () => unwrap<{ month: string; spending: number; income: number }[]>(getSupabase().rpc("monthly_cashflow", { p_end: end, p_months: months })),
  });
}

// ---------------------------------------------------------------------------
// Business workspaces: profit & loss
// ---------------------------------------------------------------------------
export interface BusinessSummary {
  revenue: number;
  cost_of_goods: number;
  operating_expenses: number;
  owner_contributions: number;
  owner_draws: number;
  transaction_count: number;
}

export function useBusinessSummary(from: string, to: string) {
  return useQuery({
    queryKey: [...qk.analytics, "business-summary", from, to],
    queryFn: async () => {
      const rows = await unwrap<BusinessSummary[]>(getSupabase().rpc("business_summary", { p_start: from, p_end: to }));
      return rows[0] ?? { revenue: 0, cost_of_goods: 0, operating_expenses: 0, owner_contributions: 0, owner_draws: 0, transaction_count: 0 };
    },
  });
}

/** P&L by category. Revenue and equity signed as money in; costs positive. */
export function usePnlByCategory(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: [...qk.analytics, "pnl-by-category", from, to],
    enabled,
    queryFn: () =>
      unwrap<{ category_id: string | null; pnl_class: string; amount: number; transaction_count: number }[]>(
        getSupabase().rpc("pnl_by_category", { p_start: from, p_end: to }),
      ),
  });
}

export function useMonthlyPnl(end: string, months = 12) {
  return useQuery({
    queryKey: [...qk.analytics, "monthly-pnl", end, months],
    queryFn: () =>
      unwrap<{ month: string; revenue: number; cost_of_goods: number; operating_expenses: number }[]>(
        getSupabase().rpc("monthly_pnl", { p_end: end, p_months: months }),
      ),
  });
}

export function useLargestTransactions(from: string, to: string) {
  return useQuery({
    queryKey: [...qk.transactions, "largest", from, to],
    queryFn: () =>
      unwrap<LedgerTransaction[]>(
        getSupabase()
          .from("transactions")
          .select(TRANSACTION_SELECT)
          .in("transaction_type", ["expense"])
          .eq("excluded", false)
          .gte("transaction_date", from)
          .lte("transaction_date", to)
          .order("amount", { ascending: true })
          .limit(6),
      ),
  });
}

export function useRecentTransactions(limit = 8, accountId?: string) {
  return useQuery({
    queryKey: [...qk.transactions, "recent", limit, accountId ?? null],
    queryFn: () => {
      let q = getSupabase().from("transactions").select(TRANSACTION_SELECT);
      if (accountId) q = q.eq("account_id", accountId);
      return unwrap<LedgerTransaction[]>(q.order("transaction_date", { ascending: false }).order("created_at", { ascending: false }).limit(limit));
    },
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
export function useCalendarEvents(from: string, to: string) {
  const items = useRecurringItems();
  const accounts = useAccounts();
  const data = useQuery({
    queryKey: [...qk.calendar, from, to],
    queryFn: async () => {
      const sb = getSupabase();
      const pad = (iso: string, n: number) => toISODate(addDays(fromISODate(iso), n));
      const [txns, cardPayments, occurrences, reminders] = await Promise.all([
        unwrap<Transaction[]>(
          sb
            .from("transactions")
            .select("id, transaction_date, amount, recurring_item_id, account_id, transaction_type, merchant_name")
            .not("recurring_item_id", "is", null)
            .gte("transaction_date", pad(from, -20))
            .lte("transaction_date", pad(to, 20))
            .limit(5000),
        ),
        unwrap<Transaction[]>(
          sb
            .from("transactions")
            .select("id, transaction_date, amount, recurring_item_id, account_id, transaction_type, merchant_name")
            .eq("transaction_type", "credit_card_payment")
            .is("recurring_item_id", null)
            .gte("transaction_date", pad(from, -30))
            .lte("transaction_date", pad(to, 5))
            .limit(2000),
        ),
        unwrap<RecurringOccurrence[]>(sb.from("recurring_occurrences").select("*").gte("expected_date", pad(from, -20)).lte("expected_date", pad(to, 20))),
        unwrap<CalendarReminder[]>(sb.from("calendar_reminders").select("*").gte("reminder_date", from).lte("reminder_date", to)),
      ]);
      return { txns: [...txns, ...cardPayments], occurrences, reminders };
    },
  });

  const events: CalendarEvent[] | undefined =
    data.data && items.data && accounts.data
      ? buildCalendar({
          from,
          to,
          today: todayISO(),
          items: items.data,
          accounts: accounts.data,
          occurrences: data.data.occurrences,
          reminders: data.data.reminders,
          transactions: data.data.txns,
        })
      : undefined;

  return { events, reminders: data.data?.reminders ?? [], isLoading: data.isLoading || items.isLoading || accounts.isLoading, isError: data.isError };
}

export function useSaveReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string; values: TablesInsert<"calendar_reminders"> | TablesUpdate<"calendar_reminders"> }) => {
      const sb = getSupabase();
      if (id)
        return unwrap<CalendarReminder>(
          sb
            .from("calendar_reminders")
            .update(values as TablesUpdate<"calendar_reminders">)
            .eq("id", id)
            .select()
            .single(),
        );
      return unwrap<CalendarReminder>(
        sb
          .from("calendar_reminders")
          .insert(values as TablesInsert<"calendar_reminders">)
          .select()
          .single(),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.calendar }),
    onError: (e) => reportError(e, "Could not save reminder."),
  });
}

export function useDeleteReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(getSupabase().from("calendar_reminders").delete().eq("id", id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.calendar });
      toast.success("Reminder deleted");
    },
    onError: (e) => reportError(e, "Could not delete reminder."),
  });
}

/** Skip (or un-skip) a single expected occurrence of a recurring item. */
export function useSetOccurrence() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, date, status }: { itemId: string; date: string; status: "skipped" | "projected" }) => {
      const sb = getSupabase();
      if (status === "projected") {
        await unwrap(sb.from("recurring_occurrences").delete().eq("recurring_item_id", itemId).eq("expected_date", date));
        return;
      }
      const existing = await unwrap<RecurringOccurrence[]>(
        sb.from("recurring_occurrences").select("id").eq("recurring_item_id", itemId).eq("expected_date", date),
      );
      if (existing.length) await unwrap(sb.from("recurring_occurrences").update({ status }).eq("id", existing[0].id));
      else await unwrap(sb.from("recurring_occurrences").insert({ recurring_item_id: itemId, expected_date: date, status }));
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: qk.calendar });
      toast.success(v.status === "skipped" ? "Occurrence skipped" : "Occurrence restored");
    },
    onError: (e) => reportError(e, "Could not update occurrence."),
  });
}
