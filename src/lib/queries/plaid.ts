"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import type { PlaidAccountSnapshot } from "@/lib/plaid/mapping";
import { reportError } from "@/lib/errors";
import { qk, unwrap } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

export interface PlaidItemView {
  id: string;
  institution_name: string | null;
  status: "active" | "login_required" | "error";
  error_code: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  plaid_accounts: PlaidAccountSnapshot[];
  /** Card statements (Plaid Liabilities): null until a sync has tried. */
  liabilities_status: "ok" | "pending" | "consent_required" | "unsupported" | "not_enabled" | "error" | null;
  created_at: string;
}

export interface SyncResult {
  itemId: string;
  institution: string | null;
  added: number;
  updated: number;
  removed: number;
  matchedExisting: number;
  recurringLinked?: number;
  statementsUpdated?: number;
  ok: boolean;
  error?: string;
}

export type AccountMapping =
  | { action: "existing"; plaidAccountId: string; accountId: string; syncFrom: string | null; replaces?: string | null }
  | { action: "new"; plaidAccountId: string; name: string; accountType: string; workspaceId: string; replaces?: string | null }
  | { action: "skip"; plaidAccountId: string };

const PLAID_ITEMS = ["plaid-items"] as const;
export const COINBASE_CONNECTIONS = ["coinbase-connections"] as const;

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? "Request failed"), { code: "22023", message: json.error ?? "Request failed" });
  return json as T;
}

export function usePlaidStatus() {
  return useQuery({
    queryKey: ["plaid-status"],
    queryFn: () => api<{ configured: boolean; backgroundSync: boolean; environment: string; coinbase: boolean }>("/api/plaid/status"),
    staleTime: 5 * 60_000,
  });
}

export function usePlaidItems() {
  return useQuery({
    queryKey: PLAID_ITEMS,
    queryFn: () =>
      unwrap<PlaidItemView[]>(
        // access_token_enc is deliberately not selected.
        getSupabase()
          .from("plaid_items")
          .select("id, institution_name, status, error_code, last_synced_at, last_sync_error, plaid_accounts, liabilities_status, created_at")
          .order("created_at"),
      ),
  });
}

export const createLinkToken = (itemId?: string) => api<{ linkToken: string }>("/api/plaid/link-token", { itemId });

export const exchangePublicToken = (publicToken: string, institution?: { id?: string | null; name?: string | null }) =>
  api<{ item: { id: string; institution_name: string | null }; accounts: PlaidAccountSnapshot[] }>("/api/plaid/exchange", { publicToken, institution });

export function summarize(results: SyncResult[]) {
  const failed = results.filter((r) => !r.ok);
  const added = results.reduce((s, r) => s + r.added, 0);
  const updated = results.reduce((s, r) => s + r.updated + r.matchedExisting, 0);
  const linked = results.reduce((s, r) => s + (r.recurringLinked ?? 0), 0);
  if (failed.length) toast.error(failed.map((f) => `${f.institution ?? "Bank"}: ${f.error}`).join("\n"));
  else if (added || updated)
    toast.success(
      `Synced ${added} new transaction${added === 1 ? "" : "s"}${updated ? `, ${updated} updated` : ""}${linked ? ` · ${linked} linked to recurring` : ""}`,
    );
  else toast.success("Up to date");
}

export function useInvalidateAfterSync() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: PLAID_ITEMS });
    qc.invalidateQueries({ queryKey: COINBASE_CONNECTIONS });
    qc.invalidateQueries({ queryKey: qk.transactions });
    qc.invalidateQueries({ queryKey: qk.accounts });
    qc.invalidateQueries({ queryKey: qk.analytics });
    qc.invalidateQueries({ queryKey: qk.counts });
    qc.invalidateQueries({ queryKey: qk.calendar });
    qc.invalidateQueries({ queryKey: qk.recurring });
  };
}

export function useLinkAccounts() {
  const invalidate = useInvalidateAfterSync();
  return useMutation({
    mutationFn: (args: { itemId: string; mappings: AccountMapping[] }) => api<{ result: SyncResult }>("/api/plaid/link-accounts", args),
    onSuccess: ({ result }) => {
      invalidate();
      if (!result.ok) toast.error(result.error ?? "First sync failed");
      else if (result.added || result.matchedExisting)
        toast.success(`Linked. Imported ${result.added} transactions${result.matchedExisting ? `, matched ${result.matchedExisting} you already had` : ""}.`);
      else toast.success("Linked. Your bank's history can take a few minutes to arrive; it will appear on the next sync.");
    },
    onError: (e) => reportError(e, "Could not link accounts."),
  });
}

export function useSyncNow() {
  const invalidate = useInvalidateAfterSync();
  return useMutation({
    mutationFn: (itemId?: string) => api<{ results: SyncResult[] }>("/api/sync", { itemId }),
    onSuccess: ({ results }) => {
      invalidate();
      summarize(results);
    },
    onError: (e) => reportError(e, "Sync failed."),
  });
}

export function useRemoveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => api<{ ok: true }>("/api/plaid/remove", { itemId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PLAID_ITEMS });
      qc.invalidateQueries({ queryKey: qk.accounts });
      toast.success("Bank disconnected. Its accounts and history are kept.");
    },
    onError: (e) => reportError(e, "Could not disconnect."),
  });
}

const AUTO_SYNC_KEY = "ledger.plaid.autosync";

/** Quietly sync once per browser session when connections haven't synced in a few hours. */
export function usePlaidAutoSync() {
  const invalidate = useInvalidateAfterSync();
  useEffect(() => {
    try {
      if (sessionStorage.getItem(AUTO_SYNC_KEY)) return;
      sessionStorage.setItem(AUTO_SYNC_KEY, "1");
    } catch {
      /* storage unavailable: still fine to try once */
    }
    let cancelled = false;
    (async () => {
      const db = getSupabase();
      const [plaidItems, coinbase] = await Promise.all([
        db.from("plaid_items").select("id", { count: "exact", head: true }),
        db.from("coinbase_connections").select("id", { count: "exact", head: true }),
      ]);
      if (!(plaidItems.count || coinbase.count) || cancelled) return;
      const { results } = await api<{ results: SyncResult[] }>("/api/sync", { onlyIfStaleMinutes: 240 });
      if (!cancelled && results.some((r) => r.added || r.updated || r.removed)) invalidate();
    })().catch(() => {
      /* background convenience only; Connections page shows errors */
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount
  }, []);
}
