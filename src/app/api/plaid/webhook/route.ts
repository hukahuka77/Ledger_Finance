import { after, NextResponse } from "next/server";
import { backgroundSyncConfigured } from "@/lib/server/env";
import { syncItem } from "@/lib/server/plaid-sync";
import { verifyPlaidWebhook } from "@/lib/server/plaid-webhook";
import { supabaseAdmin } from "@/lib/server/supabase-admin";

export const maxDuration = 300;

type PlaidWebhook = { webhook_type?: string; webhook_code?: string; item_id?: string; error?: { error_code?: string } | null };

/** Plaid → app notifications. Verified, acknowledged immediately, processed after the response. */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!(await verifyPlaidWebhook(raw, request.headers.get("plaid-verification")))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  if (!backgroundSyncConfigured()) return NextResponse.json({ ok: true, skipped: "background sync not configured" });

  let body: PlaidWebhook;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.item_id) return NextResponse.json({ ok: true });

  after(async () => {
    const db = supabaseAdmin();
    const { data: item } = await db.from("plaid_items").select("*").eq("item_id", body.item_id!).maybeSingle();
    if (!item) return;
    const type = body.webhook_type;
    const code = body.webhook_code;
    if (
      (type === "TRANSACTIONS" &&
        (code === "SYNC_UPDATES_AVAILABLE" || code === "DEFAULT_UPDATE" || code === "INITIAL_UPDATE" || code === "HISTORICAL_UPDATE")) ||
      // New statement or due date on a card.
      (type === "LIABILITIES" && code === "DEFAULT_UPDATE")
    ) {
      await syncItem(db, item, item.user_id, { asService: true });
    } else if (type === "ITEM" && (code === "ERROR" || code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT" || code === "USER_PERMISSION_REVOKED")) {
      await db
        .from("plaid_items")
        .update({ status: "login_required", error_code: body.error?.error_code ?? code, last_sync_error: "Your bank needs you to sign in again." })
        .eq("id", item.id)
        .eq("user_id", item.user_id);
    } else if (type === "ITEM" && code === "LOGIN_REPAIRED") {
      await db.from("plaid_items").update({ status: "active", error_code: null, last_sync_error: null }).eq("id", item.id).eq("user_id", item.user_id);
      await syncItem(db, { ...item, status: "active" }, item.user_id, { asService: true });
    }
  });
  return NextResponse.json({ ok: true });
}
