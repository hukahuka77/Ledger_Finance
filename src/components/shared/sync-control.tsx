"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useCoinbaseConnections } from "@/lib/queries/coinbase";
import { usePlaidItems, useSyncNow } from "@/lib/queries/plaid";

/** Re-render every minute so "synced 3 min ago" stays truthful. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
}

/**
 * "Synced 5 min ago  [Sync]" for bank and Coinbase connections. Renders nothing when nothing is connected.
 * Pass `itemId` to scope to one connection (an account's own bank or Coinbase key).
 */
export function SyncControl({ itemId, compact }: { itemId?: string | null; compact?: boolean }) {
  useMinuteTick();
  const { data: items } = usePlaidItems();
  const { data: coinbase } = useCoinbaseConnections();
  const sync = useSyncNow();
  const connections = [
    ...(items ?? []).map((i) => ({
      id: i.id,
      name: i.institution_name ?? "Bank",
      ok: i.status === "active",
      last_synced_at: i.last_synced_at,
      error: i.last_sync_error,
    })),
    ...(coinbase ?? []).map((c) => ({ id: c.id, name: "Coinbase", ok: c.status === "active", last_synced_at: c.last_synced_at, error: c.last_sync_error })),
  ];
  const relevant = connections.filter((i) => !itemId || i.id === itemId);
  if (!relevant.length) return null;

  const needsAttention = relevant.filter((i) => !i.ok);
  const syncedTimes = relevant.map((i) => i.last_synced_at).filter(Boolean) as string[];
  const latest = syncedTimes.length ? syncedTimes.reduce((a, b) => (a > b ? a : b)) : null;
  const label = sync.isPending ? "Syncing…" : latest ? `Synced ${formatDistanceToNowStrict(new Date(latest), { addSuffix: true })}` : "Not synced yet";

  return (
    <div className="flex items-center gap-2">
      {needsAttention.length ? (
        <Link
          href="/settings/connections"
          className="flex items-center gap-1 text-[12.5px] text-brick hover:underline"
          title={needsAttention.map((i) => `${i.name}: ${i.error ?? "needs attention"}`).join("\n")}
        >
          <AlertTriangle className="size-3.5" />
          {compact ? null : (
            <span>{needsAttention.length === 1 ? `${needsAttention[0].name} needs attention` : `${needsAttention.length} connections need attention`}</span>
          )}
        </Link>
      ) : null}
      <span
        className={cn("text-[12.5px] whitespace-nowrap text-ink-3", compact && "hidden xl:inline")}
        title={latest ? new Date(latest).toLocaleString() : undefined}
      >
        {label}
      </span>
      <Button
        size={compact ? "md" : "sm"}
        onClick={() => sync.mutate(itemId ?? undefined)}
        disabled={sync.isPending}
        aria-label={itemId ? "Sync this connection now" : "Sync all connections now"}
        title={itemId ? "Sync this connection now" : "Sync all connections now"}
      >
        <RefreshCw className={cn(sync.isPending && "animate-spin")} />
        <span className={cn(compact && "hidden lg:inline")}>Sync</span>
      </Button>
    </div>
  );
}
