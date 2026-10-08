import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/server/auth";
import { syncCoinbase } from "@/lib/server/coinbase-sync";
import { coinbaseConfigured, plaidConfigured } from "@/lib/server/env";
import { syncItem, type SyncResult } from "@/lib/server/plaid-sync";

export const maxDuration = 300;

const Body = z.object({ itemId: z.string().uuid().optional(), onlyIfStaleMinutes: z.number().int().min(0).max(10080).optional() });

/**
 * Sync the signed-in user's connections: Plaid items and Coinbase keys (all, one by id,
 * or only those not synced recently).
 */
export async function POST(request: Request) {
  // Connections can feed accounts in any of the user's workspaces.
  const auth = await requireUser("all");
  if ("error" in auth) return auth.error;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request");
  const { itemId, onlyIfStaleMinutes } = parsed.data;
  const staleBefore = onlyIfStaleMinutes !== undefined ? Date.now() - onlyIfStaleMinutes * 60_000 : null;
  const due = (lastSyncedAt: string | null) => staleBefore === null || !lastSyncedAt || Date.parse(lastSyncedAt) <= staleBefore;
  const results: SyncResult[] = [];

  if (plaidConfigured()) {
    let q = auth.supabase.from("plaid_items").select("*").neq("status", "login_required");
    if (itemId) q = q.eq("id", itemId);
    const { data: items, error } = await q;
    if (error) return jsonError("Could not load connections", 500);
    for (const item of items ?? []) if (due(item.last_synced_at)) results.push(await syncItem(auth.supabase, item, auth.userId));
  }

  if (coinbaseConfigured()) {
    // A key Coinbase rejected stays rejected until the user replaces it.
    let q = auth.supabase.from("coinbase_connections").select("*").neq("status", "auth_failed");
    if (itemId) q = q.eq("id", itemId);
    const { data: conns, error } = await q;
    if (error) return jsonError("Could not load connections", 500);
    for (const conn of conns ?? []) if (due(conn.last_synced_at)) results.push(await syncCoinbase(auth.supabase, conn, auth.userId));
  }

  return NextResponse.json({ results });
}
