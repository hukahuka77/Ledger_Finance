import { NextResponse } from "next/server";
import { z } from "zod";
import { ACCOUNT_TYPE_OPTIONS } from "@/lib/domain";
import type { PlaidAccountSnapshot } from "@/lib/plaid/mapping";
import { jsonError, requireUser } from "@/lib/server/auth";
import { syncItem } from "@/lib/server/plaid-sync";

export const maxDuration = 300;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  itemId: z.string().uuid(),
  mappings: z
    .array(
      z.discriminatedUnion("action", [
        z.object({
          action: z.literal("existing"),
          plaidAccountId: z.string().max(200),
          accountId: z.string().uuid(),
          syncFrom: z.string().regex(DATE).nullable(),
          /** The ledger account this row was linked to before, whose link this replaces. */
          replaces: z.string().uuid().nullish(),
        }),
        z.object({
          action: z.literal("new"),
          plaidAccountId: z.string().max(200),
          name: z.string().trim().min(1).max(120),
          /** Workspace the new account goes in (one the user can edit). */
          workspaceId: z.string().uuid(),
          accountType: z.enum(ACCOUNT_TYPE_OPTIONS.map((o) => o.value) as [string, ...string[]]),
          replaces: z.string().uuid().nullish(),
        }),
        z.object({ action: z.literal("skip"), plaidAccountId: z.string().max(200) }),
      ]),
    )
    .max(50),
});

/**
 * Links (or unlinks) each Plaid account to a ledger account, in any workspace the user can
 * edit, then runs a first sync.
 */
export async function POST(request: Request) {
  const auth = await requireUser("all");
  if ("error" in auth) return auth.error;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid account mapping");
  const { supabase: db, userId } = auth;

  const { data: item } = await db.from("plaid_items").select("*").eq("id", parsed.data.itemId).maybeSingle();
  if (!item) return jsonError("Connection not found", 404);
  const snapshot = new Map(((item.plaid_accounts as unknown as PlaidAccountSnapshot[]) ?? []).map((a) => [a.account_id, a]));

  for (const m of parsed.data.mappings) {
    const pa = snapshot.get(m.plaidAccountId);
    if (!pa) return jsonError("Unknown bank account in mapping");
    // A bank account maps to at most one ledger account per workspace. Release the link this row
    // replaces and any other link in the target workspace; copies mirrored into other workspaces
    // stay linked. "Don't sync" releases every copy.
    let release = db.from("accounts").update({ plaid_item_id: null, plaid_account_id: null }).eq("plaid_account_id", m.plaidAccountId);
    if (m.action !== "skip") {
      let targetWorkspace = m.action === "new" ? m.workspaceId : null;
      if (m.action === "existing") {
        const { data: target } = await db.from("accounts").select("workspace_id").eq("id", m.accountId).maybeSingle();
        if (!target) return jsonError("Could not link account", 404);
        targetWorkspace = target.workspace_id;
        release = release.neq("id", m.accountId);
      }
      release = release.or(`workspace_id.eq.${targetWorkspace}${m.replaces ? `,id.eq.${m.replaces}` : ""}`);
    }
    const { error: clearErr } = await release;
    if (clearErr) return jsonError("Could not update accounts", 500);

    if (m.action === "existing") {
      const { data, error } = await db
        .from("accounts")
        .update({ plaid_item_id: item.id, plaid_account_id: m.plaidAccountId, sync_from: m.syncFrom, institution: item.institution_name })
        .eq("id", m.accountId)
        .select("id");
      if (error || !data?.length) return jsonError("Could not link account", error ? 500 : 404);
    } else if (m.action === "new") {
      const { error } = await db.from("accounts").insert({
        workspace_id: m.workspaceId,
        name: m.name,
        account_type: m.accountType,
        institution: item.institution_name,
        last_four: pa.mask?.replace(/[^0-9A-Za-z]/g, "").slice(-4) || null,
        plaid_item_id: item.id,
        plaid_account_id: m.plaidAccountId,
      });
      if (error)
        return jsonError((error as { code?: string }).code === "23505" ? `An account named “${m.name}” already exists` : "Could not create account", 400);
    }
  }

  // Start from scratch so newly linked accounts receive their full history.
  await db.from("plaid_items").update({ cursor: null }).eq("id", item.id).eq("user_id", userId);
  const result = await syncItem(db, { ...item, cursor: null }, userId);
  return NextResponse.json({ result });
}
