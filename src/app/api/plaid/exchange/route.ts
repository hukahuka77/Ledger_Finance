import { NextResponse } from "next/server";
import { z } from "zod";
import type { Json } from "@/lib/database.types";
import { jsonError, requireUser } from "@/lib/server/auth";
import { encryptSecret } from "@/lib/server/crypto";
import { plaidConfigured } from "@/lib/server/env";
import { plaid, plaidErrorMessage } from "@/lib/server/plaid";
import { snapshotAccounts } from "@/lib/server/plaid-sync";

const Body = z.object({
  publicToken: z.string().min(1).max(500),
  institution: z.object({ id: z.string().max(100).nullable().optional(), name: z.string().max(200).nullable().optional() }).optional(),
});

/** Exchanges Link's public token for an access token, stored encrypted. Returns the item's accounts for mapping. */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (!plaidConfigured()) return jsonError("Bank connections aren't configured on the server yet.", 503);
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request");

  try {
    const { data: ex } = await plaid().itemPublicTokenExchange({ public_token: parsed.data.publicToken });
    const { data: acc } = await plaid().accountsGet({ access_token: ex.access_token });
    const accounts = snapshotAccounts(acc.accounts);
    const { data: item, error } = await auth.supabase
      .from("plaid_items")
      .insert({
        user_id: auth.userId,
        item_id: ex.item_id,
        access_token_enc: encryptSecret(ex.access_token),
        institution_id: parsed.data.institution?.id ?? acc.item.institution_id ?? null,
        institution_name: parsed.data.institution?.name?.trim() || null,
        plaid_accounts: accounts as unknown as Json,
      })
      .select("id, institution_name")
      .single();
    if (error) throw error;
    return NextResponse.json({ item, accounts });
  } catch (err) {
    console.error("[plaid] exchange", (err as Error).message);
    return jsonError(plaidErrorMessage(err), 502);
  }
}
