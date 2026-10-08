"use client";

import { useQuery } from "@tanstack/react-query";
import { addDays } from "date-fns";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { toISODate, todayISO } from "@/lib/dates";
import { detectRecurring, type DetectInputTxn } from "@/lib/recurring-detect";
import { qk, unwrap, useCategoryIndex, useRecurringItems } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";
import { recurringPatterns } from "@/lib/recurring-match";

const DISMISSED_KEY = "ledger.recurring.dismissed";
const listeners = new Set<() => void>();

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

/** Dismissed suggestions are a per-browser UI preference (they don't change any data). */
function useDismissed() {
  const raw = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readDismissed,
    () => "[]",
  );
  const dismissed = useMemo(() => new Set<string>(JSON.parse(raw)), [raw]);
  const dismiss = useCallback(
    (key: string) => {
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed, key].slice(-500)));
      } catch {
        /* preference only */
      }
      listeners.forEach((l) => l());
    },
    [dismissed],
  );
  return { dismissed, dismiss };
}

/** Recurring patterns detected in the last ~13 months that aren't tracked yet. */
export function useRecurringSuggestions() {
  const items = useRecurringItems();
  const cats = useCategoryIndex();
  const { dismissed, dismiss } = useDismissed();
  const history = useQuery({
    queryKey: [...qk.transactions, "recurring-detect"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const since = toISODate(addDays(new Date(), -400));
      const out: DetectInputTxn[] = [];
      for (let from = 0; from < 10_000; from += 1000) {
        const page = await unwrap<DetectInputTxn[]>(
          getSupabase()
            .from("transactions")
            .select("id, transaction_date, amount, merchant_name, account_id, category_id, transaction_type, recurring_item_id")
            .gte("transaction_date", since)
            .is("recurring_item_id", null)
            .eq("excluded", false)
            .order("id")
            .range(from, from + 999),
        );
        out.push(...page);
        if (page.length < 1000) break;
      }
      return out;
    },
  });

  const suggestions = useMemo(() => {
    if (!history.data || !items.data) return [];
    return detectRecurring(history.data, {
      today: todayISO(),
      existingPatterns: items.data.flatMap((r) => [...recurringPatterns(r), r.name]),
      categoryNameById: new Map(cats.all.map((c) => [c.id, c.name])),
      dismissed,
    });
  }, [history.data, items.data, cats.all, dismissed]);

  return { suggestions, isLoading: history.isLoading || items.isLoading, dismiss };
}
