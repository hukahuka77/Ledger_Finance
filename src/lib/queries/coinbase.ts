"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { WalletSnapshot } from "@/lib/coinbase/mapping";
import { reportError } from "@/lib/errors";
import { api, COINBASE_CONNECTIONS, useInvalidateAfterSync, type SyncResult } from "@/lib/queries/plaid";
import { qk, unwrap } from "@/lib/queries/reference";
import { getSupabase } from "@/lib/supabase/client";

export interface CoinbaseConnectionView {
  id: string;
  key_name: string;
  account_id: string | null;
  status: "active" | "auth_failed" | "error";
  last_synced_at: string | null;
  last_sync_error: string | null;
  wallets: WalletSnapshot[];
  created_at: string;
}

export function useCoinbaseConnections() {
  return useQuery({
    queryKey: COINBASE_CONNECTIONS,
    queryFn: () =>
      unwrap<CoinbaseConnectionView[]>(
        // private_key_enc is deliberately not selected.
        getSupabase()
          .from("coinbase_connections")
          .select("id, key_name, account_id, status, last_synced_at, last_sync_error, wallets, created_at")
          .order("created_at"),
      ),
  });
}

export function useConnectCoinbase() {
  const invalidate = useInvalidateAfterSync();
  return useMutation({
    mutationFn: (args: { keyName: string; privateKey: string; accountId?: string | null }) =>
      api<{ connection: { id: string }; result: SyncResult }>("/api/coinbase/connect", args),
    onSuccess: ({ result }) => {
      invalidate();
      if (!result.ok) toast.error(`Connected, but the first sync failed: ${result.error ?? "unknown error"}`);
      else toast.success(`Coinbase connected. Imported ${result.added} transaction${result.added === 1 ? "" : "s"}.`);
    },
    // The form shows the error inline.
  });
}

export function useRemoveCoinbase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => api<{ ok: true }>("/api/coinbase/remove", { connectionId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COINBASE_CONNECTIONS });
      qc.invalidateQueries({ queryKey: qk.accounts });
      toast.success("Coinbase disconnected. Its account and history are kept.");
    },
    onError: (e) => reportError(e, "Could not disconnect."),
  });
}
