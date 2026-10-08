import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Transaction as PlaidTransaction, AccountBase, RemovedTransaction } from "plaid";
import type { Database, Json, TablesInsert, TablesUpdate } from "@/lib/database.types";
import type { AccountType } from "@/lib/domain";
import {
  cardStatementPatch,
  cleanMerchant,
  liabilitiesStatusForError,
  mapTransactionType,
  pickCategory,
  toLedgerAmount,
  type PlaidAccountSnapshot,
} from "@/lib/plaid/mapping";
import { decryptSecret } from "@/lib/server/crypto";
import { plaid, plaidErrorCode, plaidErrorMessage } from "@/lib/server/plaid";

type Db = SupabaseClient<Database>;
type ItemRow = Database["public"]["Tables"]["plaid_items"]["Row"];

export interface SyncResult {
  itemId: string;
  institution: string | null;
  added: number;
  updated: number;
  removed: number;
  matchedExisting: number;
  skipped: number;
  /** New transactions linked to a recurring item by its match phrases. */
  recurringLinked: number;
  /** Credit cards whose statement balance and due date were refreshed. */
  statementsUpdated?: number;
  ok: boolean;
  error?: string;
}

/** Errors that mean the user has to re-authenticate through Plaid Link. */
const LOGIN_ERRORS = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "ACCESS_NOT_GRANTED", "NO_ACCOUNTS", "INVALID_UPDATED_USERNAME"]);

async function must<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw error;
  return data as NonNullable<T>;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const shiftDate = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function snapshotAccounts(accounts: AccountBase[]): PlaidAccountSnapshot[] {
  return accounts.map((a) => ({
    account_id: a.account_id,
    name: a.name,
    official_name: a.official_name ?? null,
    mask: a.mask ?? null,
    type: a.type,
    subtype: a.subtype ?? null,
  }));
}

/** Pull every page of /transactions/sync from the stored cursor. Restarts if Plaid reports a mutation mid-pagination. */
async function pullChanges(accessToken: string, cursor: string | null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const added: PlaidTransaction[] = [];
    const modified: PlaidTransaction[] = [];
    const removed: RemovedTransaction[] = [];
    let accounts: AccountBase[] = [];
    let next = cursor ?? undefined;
    try {
      for (let page = 0; page < 200; page++) {
        const { data } = await plaid().transactionsSync({
          access_token: accessToken,
          cursor: next,
          count: 500,
          options: { include_original_description: true },
        });
        added.push(...data.added);
        modified.push(...data.modified);
        removed.push(...data.removed);
        accounts = data.accounts;
        next = data.next_cursor;
        if (!data.has_more) return { added, modified, removed, accounts, nextCursor: next };
      }
      throw new Error("Too many pages from Plaid");
    } catch (err) {
      if (plaidErrorCode(err) === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue;
      throw err;
    }
  }
  throw new Error("Plaid data kept changing during sync; try again shortly.");
}

/** Every account on the item with its latest cached balance; falls back to the sync response if /accounts/get fails. */
async function allAccounts(accessToken: string, syncAccounts: AccountBase[]): Promise<AccountBase[]> {
  try {
    const { data } = await plaid().accountsGet({ access_token: accessToken });
    const byId = new Map(syncAccounts.map((a) => [a.account_id, a]));
    data.accounts.forEach((a) => byId.set(a.account_id, a));
    return [...byId.values()];
  } catch (err) {
    console.warn("[plaid-sync] accounts/get", plaidErrorCode(err) ?? (err as Error)?.message);
    return syncAccounts;
  }
}

/**
 * Statement balance, due date and close date for the item's linked credit cards (Plaid
 * Liabilities). Never fails the sync: a bank that doesn't offer statements, or a
 * connection that predates the consent, is recorded in the returned status instead.
 */
async function syncCardStatements(
  db: Db,
  accessToken: string,
  cards: { id: string; plaid_account_id: string | null }[],
): Promise<{ status: NonNullable<ItemRow["liabilities_status"]>; cards: number }> {
  const byPlaidAccount = new Map<string, string[]>();
  for (const c of cards) if (c.plaid_account_id) byPlaidAccount.set(c.plaid_account_id, [...(byPlaidAccount.get(c.plaid_account_id) ?? []), c.id]);
  if (!byPlaidAccount.size) return { status: "unsupported", cards: 0 };
  let credit;
  try {
    const { data } = await plaid().liabilitiesGet({ access_token: accessToken, options: { account_ids: [...byPlaidAccount.keys()] } });
    credit = data.liabilities.credit ?? [];
  } catch (err) {
    const code = plaidErrorCode(err);
    console.warn("[plaid-sync] liabilities/get", code ?? (err as Error)?.message);
    return { status: liabilitiesStatusForError(code), cards: 0 };
  }
  let updated = 0;
  for (const l of credit) {
    const accountIds = l.account_id ? (byPlaidAccount.get(l.account_id) ?? []) : [];
    const patch = cardStatementPatch(l);
    if (!accountIds.length || !Object.keys(patch).length) continue;
    // Every workspace's copy of the card.
    await must(db.from("accounts").update(patch).in("id", accountIds));
    updated++;
  }
  return { status: "ok", cards: updated };
}

/**
 * Sync one Plaid item (owned by `userId`) into the ledger. Its accounts may live in
 * different workspaces; each transaction goes to its account's workspace and gets that
 * workspace's categories and rules. Works with either the user's own RLS-scoped client
 * (all of their workspaces) or the service-role client (`asService`), and always scopes
 * by the item's linked accounts explicitly. Idempotent: the cursor
 * only advances after every write succeeded, and rows are keyed by Plaid ids.
 */
export async function syncItem(db: Db, item: ItemRow, userId: string, opts: { asService?: boolean } = {}): Promise<SyncResult> {
  const result: SyncResult = {
    itemId: item.id,
    institution: item.institution_name,
    added: 0,
    updated: 0,
    removed: 0,
    matchedExisting: 0,
    skipped: 0,
    recurringLinked: 0,
    ok: true,
  };
  try {
    const accessToken = decryptSecret(item.access_token_enc);
    const { added, modified, removed, accounts: syncAccounts, nextCursor } = await pullChanges(accessToken, item.cursor);
    // /transactions/sync only reports accounts that support transactions, so brokerage and
    // retirement accounts never appear there. /accounts/get covers every account on the item.
    const plaidAccounts = await allAccounts(accessToken, syncAccounts);

    // Ledger accounts mapped to this item.
    const linked = await must(
      db.from("accounts").select("id, workspace_id, account_type, plaid_account_id, sync_from, credit_limit, track_transactions").eq("plaid_item_id", item.id),
    );
    // A bank account mirrored into several workspaces has one ledger account per workspace.
    const byPlaidAccount = new Map<string, typeof linked>();
    for (const a of linked) {
      if (a.plaid_account_id) byPlaidAccount.set(a.plaid_account_id, [...(byPlaidAccount.get(a.plaid_account_id) ?? []), a]);
    }
    const linkedIds = linked.map((a) => a.id);

    // Category lookup by (lower-case) name for Plaid → workspace taxonomy mapping, per workspace.
    const workspaceIds = [...new Set(linked.map((a) => a.workspace_id))];
    const cats = workspaceIds.length
      ? await must(db.from("categories").select("id, workspace_id, name, active, parent_category_id").in("workspace_id", workspaceIds))
      : [];
    const catsByWorkspace = new Map<string, Map<string, string>>();
    for (const c of [...cats].sort((a, b) => Number(Boolean(b.parent_category_id)) - Number(Boolean(a.parent_category_id)))) {
      const byName = catsByWorkspace.get(c.workspace_id) ?? new Map<string, string>();
      catsByWorkspace.set(c.workspace_id, byName);
      if (c.active && !byName.has(c.name.toLowerCase())) byName.set(c.name.toLowerCase(), c.id);
    }

    // Existing rows already carrying any Plaid id we are about to touch, keyed by ledger account + Plaid id.
    const touchedIds = [...new Set([...added, ...modified].flatMap((t) => [t.transaction_id, t.pending_transaction_id].filter(Boolean) as string[]))];
    const existingByPlaidId = new Map<string, { id: string }>();
    const existingKey = (accountId: string, plaidTransactionId: string) => `${accountId}|${plaidTransactionId}`;
    for (const ids of chunk(touchedIds, 150)) {
      const rows = await must(
        db.from("transactions").select("id, account_id, plaid_transaction_id").in("account_id", linkedIds).in("plaid_transaction_id", ids),
      );
      rows.forEach((r) => existingByPlaidId.set(existingKey(r.account_id, r.plaid_transaction_id!), { id: r.id }));
    }

    // Candidate CSV/manual rows (no Plaid id) that a newly-synced charge may duplicate.
    const tracked = (plaidAccountId: string) => (byPlaidAccount.get(plaidAccountId) ?? []).filter((a) => a.track_transactions);
    const relevant = added.filter((t) => tracked(t.account_id).length);
    const fuzzyPool = new Map<string, { id: string; date: string }[]>();
    if (relevant.length) {
      const dates = relevant.map((t) => t.date).sort();
      const accountIds = [...new Set(relevant.flatMap((t) => tracked(t.account_id).map((a) => a.id)))];
      for (let from = 0; ; from += 1000) {
        const rows = await must(
          db
            .from("transactions")
            .select("id, account_id, transaction_date, amount")
            .in("account_id", accountIds)
            .is("plaid_transaction_id", null)
            .gte("transaction_date", shiftDate(dates[0], -3))
            .lte("transaction_date", shiftDate(dates[dates.length - 1], 3))
            .order("id")
            .range(from, from + 999),
        );
        rows.forEach((r) => {
          const k = `${r.account_id}|${Math.round(r.amount * 100)}`;
          fuzzyPool.set(k, [...(fuzzyPool.get(k) ?? []), { id: r.id, date: r.transaction_date }]);
        });
        if (rows.length < 1000) break;
      }
    }
    const takeFuzzy = (accountId: string, amount: number, date: string) => {
      const list = fuzzyPool.get(`${accountId}|${Math.round(amount * 100)}`);
      if (!list?.length) return undefined;
      const idx = list.findIndex((r) => Math.abs(Date.parse(r.date) - Date.parse(date)) <= 3 * 86_400_000);
      if (idx < 0) return undefined;
      return list.splice(idx, 1)[0];
    };

    const inserts: TablesInsert<"transactions">[] = [];
    const updates: { id: string; patch: TablesUpdate<"transactions"> }[] = [];

    const bankFields = (t: PlaidTransaction): TablesUpdate<"transactions"> => ({
      plaid_transaction_id: t.transaction_id,
      amount: toLedgerAmount(t.amount),
      transaction_date: t.date,
      posted_date: t.pending ? null : t.date,
      status: t.pending ? "pending" : "posted",
      original_description: (t.original_description ?? t.name ?? "").slice(0, 500) || null,
    });

    for (const t of [...added].sort((a, b) => a.date.localeCompare(b.date))) {
      // Every workspace's copy of the bank account gets the charge.
      // Not linked, set to balance only, or before the account's import start date: skipped.
      const accts = tracked(t.account_id).filter((a) => !a.sync_from || t.date >= a.sync_from);
      if (!accts.length) result.skipped++;
      for (const acct of accts) {
        // Already stored (replayed page), or the posted version of a pending charge we have.
        const existing =
          existingByPlaidId.get(existingKey(acct.id, t.transaction_id)) ??
          (t.pending_transaction_id ? existingByPlaidId.get(existingKey(acct.id, t.pending_transaction_id)) : undefined);
        if (existing) {
          updates.push({ id: existing.id, patch: bankFields(t) });
          continue;
        }
        const amount = toLedgerAmount(t.amount);
        const dupe = takeFuzzy(acct.id, amount, t.date);
        if (dupe) {
          // Same charge already imported from CSV: adopt it rather than duplicating.
          updates.push({ id: dupe.id, patch: { plaid_transaction_id: t.transaction_id, status: t.pending ? "pending" : "posted" } });
          result.matchedExisting++;
          continue;
        }
        const type = mapTransactionType(t, acct.account_type as AccountType);
        const id = crypto.randomUUID();
        inserts.push({
          id,
          workspace_id: acct.workspace_id,
          account_id: acct.id,
          ...bankFields(t),
          amount,
          transaction_date: t.date,
          merchant_name: cleanMerchant(t),
          currency: (t.iso_currency_code ?? "USD").slice(0, 3).toUpperCase(),
          transaction_type: type,
          category_id:
            type === "transfer" || type === "credit_card_payment"
              ? null
              : pickCategory(t.personal_finance_category, catsByWorkspace.get(acct.workspace_id) ?? new Map()),
          review_status: "unreviewed",
          external_transaction_id: t.transaction_id,
        });
        existingByPlaidId.set(existingKey(acct.id, t.transaction_id), { id });
      }
    }

    for (const t of modified) {
      for (const acct of byPlaidAccount.get(t.account_id) ?? []) {
        const existing = existingByPlaidId.get(existingKey(acct.id, t.transaction_id));
        if (existing) updates.push({ id: existing.id, patch: bankFields(t) });
      }
    }

    // ---- Writes -------------------------------------------------------------
    for (const batch of chunk(inserts, 500)) await must(db.from("transactions").insert(batch));
    result.added = inserts.length;

    for (const u of updates) {
      const { error } = await db.from("transactions").update(u.patch).eq("id", u.id).in("account_id", linkedIds);
      // A split parent can't change amount; keep the user's split and just record the rest.
      if (error && (error as { code?: string }).code === "23514") {
        const { amount: _amount, ...rest } = u.patch;
        void _amount;
        await must(db.from("transactions").update(rest).eq("id", u.id).in("account_id", linkedIds));
      } else if (error) {
        throw error;
      }
    }
    result.updated = updates.length - result.matchedExisting;

    const removedIds = removed.map((r) => r.transaction_id).filter(Boolean) as string[];
    for (const ids of chunk(removedIds, 150)) {
      const gone = await must(db.from("transactions").delete().in("account_id", linkedIds).in("plaid_transaction_id", ids).select("id"));
      result.removed += gone.length;
    }

    // Categorization rules on newly inserted rows.
    if (inserts.length) {
      for (const ids of chunk(
        inserts.map((i) => i.id!),
        2000,
      )) {
        if (opts.asService) await must(db.rpc("apply_categorization_rules_as", { p_user_id: userId, p_transaction_ids: ids }));
        else await must(db.rpc("apply_categorization_rules", { p_transaction_ids: ids, p_only_unreviewed: true, p_import_only: true }));
        // After rules, so a rule that sets a recurring item explicitly wins.
        result.recurringLinked += opts.asService
          ? await must(db.rpc("auto_link_recurring_as", { p_user_id: userId, p_transaction_ids: ids }))
          : await must(db.rpc("auto_link_recurring", { p_transaction_ids: ids }));
      }
    }

    // Balances straight from the bank.
    const today = new Date().toISOString().slice(0, 10);
    for (const pa of plaidAccounts) {
      if (pa.balances.current === null || pa.balances.current === undefined) continue;
      for (const acct of byPlaidAccount.get(pa.account_id) ?? []) {
        const patch: TablesUpdate<"accounts"> = {
          current_balance: Math.round(pa.balances.current * 100) / 100,
          available_balance: pa.balances.available ?? null,
          balance_as_of: today,
        };
        if (acct.account_type === "credit_card" && pa.balances.limit !== null && pa.balances.limit !== undefined) patch.credit_limit = pa.balances.limit;
        await must(db.from("accounts").update(patch).eq("id", acct.id));
      }
    }

    // Statements only for items with a linked card, so banks without cards aren't billed for Liabilities.
    const cards = linked.filter((a) => a.account_type === "credit_card");
    const statements = cards.length ? await syncCardStatements(db, accessToken, cards) : null;
    result.statementsUpdated = statements?.cards ?? 0;

    await must(
      db
        .from("plaid_items")
        .update({
          ...(statements ? { liabilities_status: statements.status } : {}),
          cursor: nextCursor,
          last_synced_at: new Date().toISOString(),
          status: "active",
          error_code: null,
          last_sync_error: null,
          ...(plaidAccounts.length ? { plaid_accounts: snapshotAccounts(plaidAccounts) as unknown as Json } : {}),
        })
        .eq("id", item.id)
        .eq("user_id", userId),
    );
    return result;
  } catch (err) {
    const code = plaidErrorCode(err);
    const message = code ? plaidErrorMessage(err) : "Sync failed. Try again in a few minutes.";
    console.error("[plaid-sync]", item.id, code ?? "", (err as Error)?.message ?? err);
    await db
      .from("plaid_items")
      .update({ status: code && LOGIN_ERRORS.has(code) ? "login_required" : "error", error_code: code ?? null, last_sync_error: message.slice(0, 1000) })
      .eq("id", item.id)
      .eq("user_id", userId);
    return { ...result, ok: false, error: message };
  }
}
