import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/server/auth";
import { decryptSecret } from "@/lib/server/crypto";
import { plaid } from "@/lib/server/plaid";

const Body = z.object({ itemId: z.string().uuid() });

/** Revokes the connection at Plaid and forgets it. Accounts and transactions are kept. */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request");

  const { data: item } = await auth.supabase.from("plaid_items").select("id, access_token_enc").eq("id", parsed.data.itemId).maybeSingle();
  if (!item) return jsonError("Connection not found", 404);
  try {
    await plaid().itemRemove({ access_token: decryptSecret(item.access_token_enc) });
  } catch (err) {
    // Already invalid at Plaid (e.g. revoked at the bank) — still remove our copy.
    console.warn("[plaid] item remove", (err as Error).message);
  }
  const { error } = await auth.supabase.from("plaid_items").delete().eq("id", item.id).eq("user_id", auth.userId);
  if (error) return jsonError("Could not remove connection", 500);
  return NextResponse.json({ ok: true });
}
