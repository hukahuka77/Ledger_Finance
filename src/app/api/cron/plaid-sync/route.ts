import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { syncCoinbase } from "@/lib/server/coinbase-sync";
import { backgroundSyncConfigured, coinbaseConfigured, serverEnv } from "@/lib/server/env";
import { syncItem } from "@/lib/server/plaid-sync";
import { supabaseAdmin } from "@/lib/server/supabase-admin";

export const maxDuration = 300;

function authorized(request: Request) {
  const expected = `Bearer ${serverEnv.cronSecret}`;
  const got = request.headers.get("authorization") ?? "";
  return Boolean(serverEnv.cronSecret) && got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Daily safety-net sync for every active connection (Vercel Cron). */
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const plaidOn = backgroundSyncConfigured();
  const coinbaseOn = coinbaseConfigured() && Boolean(serverEnv.supabaseServiceRoleKey);
  if (!plaidOn && !coinbaseOn) return NextResponse.json({ ok: true, skipped: "background sync not configured" });
  const db = supabaseAdmin();
  let ok = 0;
  let failed = 0;
  const tally = (r: { ok: boolean }) => (r.ok ? ok++ : failed++);
  if (plaidOn) {
    const { data: items } = await db.from("plaid_items").select("*").eq("status", "active");
    for (const item of items ?? []) tally(await syncItem(db, item, item.user_id, { asService: true }));
  }
  if (coinbaseOn) {
    // Errors other than a rejected key (e.g. a Coinbase outage) are retried.
    const { data: conns } = await db.from("coinbase_connections").select("*").neq("status", "auth_failed");
    for (const conn of conns ?? []) tally(await syncCoinbase(db, conn, conn.user_id, { asService: true }));
  }
  return NextResponse.json({ ok, failed });
}
