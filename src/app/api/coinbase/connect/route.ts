import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/server/auth";
import { CoinbaseClient, CoinbaseError, normalisePrivateKey } from "@/lib/server/coinbase";
import { findOrCreateCoinbaseAccount, syncCoinbase } from "@/lib/server/coinbase-sync";
import { encryptSecret } from "@/lib/server/crypto";
import { coinbaseConfigured } from "@/lib/server/env";

export const maxDuration = 300;

const Body = z.object({
  keyName: z.string().trim().min(1).max(300),
  privateKey: z.string().min(1).max(3000),
  /** Ledger account to roll Coinbase into; omitted creates (or reuses) one named "Coinbase" in the open workspace. */
  accountId: z.string().uuid().nullish(),
});

/**
 * Connect (or replace) a read-only Coinbase API key: check it against Coinbase, store it
 * encrypted, and run the first sync.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (!coinbaseConfigured()) return jsonError("Connections aren't set up on the server yet (PLAID_TOKEN_KEY is missing).", 503);
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Enter the API key name and private key.");
  const keyName = parsed.data.keyName;
  const privateKey = normalisePrivateKey(parsed.data.privateKey);

  try {
    await new CoinbaseClient({ keyName, privateKey }).get("/v2/accounts?limit=1");
  } catch (err) {
    if (err instanceof CoinbaseError) return jsonError(err.message, 400);
    console.error("[coinbase] connect check", (err as Error)?.message);
    return jsonError("Couldn't reach Coinbase. Try again in a minute.", 502);
  }

  // Roll Coinbase into the chosen account, or a "Coinbase" account in the open workspace.
  let accountId = parsed.data.accountId ?? null;
  if (!accountId) {
    try {
      accountId = await findOrCreateCoinbaseAccount(auth.supabase);
    } catch (err) {
      console.error("[coinbase] account", (err as Error)?.message);
      return jsonError("Could not create the Coinbase account in this workspace.", 500);
    }
  }

  const { data: conn, error } = await auth.supabase
    .from("coinbase_connections")
    .upsert(
      {
        user_id: auth.userId,
        key_name: keyName,
        private_key_enc: encryptSecret(privateKey),
        status: "active",
        last_sync_error: null,
        account_id: accountId,
      },
      { onConflict: "user_id,key_name" },
    )
    .select("*")
    .single();
  if (error || !conn) {
    console.error("[coinbase] save", error?.message);
    const notFound = error?.code === "23503" || error?.code === "42501";
    return jsonError(notFound ? "That account wasn't found in a workspace you can edit." : "Could not save the connection.", notFound ? 400 : 500);
  }

  const result = await syncCoinbase(auth.supabase, conn, auth.userId);
  return NextResponse.json({ connection: { id: conn.id }, result });
}
