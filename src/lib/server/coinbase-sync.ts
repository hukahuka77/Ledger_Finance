import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, TablesInsert, TablesUpdate } from "@/lib/database.types";
import { currencyCode, mapCoinbaseTransaction, totalUsd, walletUsd, type CbAccount, type CbTransaction, type WalletSnapshot } from "@/lib/coinbase/mapping";
import { CoinbaseClient, CoinbaseError } from "@/lib/server/coinbase";
import { decryptSecret } from "@/lib/server/crypto";
import type { SyncResult } from "@/lib/server/plaid-sync";

type Db = SupabaseClient<Database>;
export type CoinbaseConnectionRow = Database["public"]["Tables"]["coinbase_connections"]["Row"];

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

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const asSnapshots = (j: Json): WalletSnapshot[] => (Array.isArray(j) ? (j as unknown as WalletSnapshot[]) : []);

/**
 * Which wallets to read transactions from. A first sync reads every wallet; after that,
 * wallets holding a balance, wallets that have ever had activity, wallets Coinbase
 * touched since the last sync, and wallets we haven't seen before.
 */
export function walletsToPoll(wallets: CbAccount[], previous: WalletSnapshot[], lastSyncedAt: string | null): CbAccount[] {
  if (!lastSyncedAt) return wallets;
  const prev = new Map(previous.map((w) => [w.id, w]));
  const since = Date.parse(lastSyncedAt) - 86_400_000;
  return wallets.filter((w) => {
    const p = prev.get(w.id);
    return !p || p.active || Number(w.balance.amount) !== 0 || (w.updated_at ? Date.parse(w.updated_at) > since : false);
  });
}

/**
 * The ledger account Coinbase rolls up into: an existing account named "Coinbase" in the
 * client's current workspace, or a new one there.
 */
export async function findOrCreateCoinbaseAccount(db: Db): Promise<string> {
  const existing = await must(db.from("accounts").select("id").ilike("name", "Coinbase").is("last_four", null).limit(1));
  if (existing[0]) return existing[0].id;
  return (await must(db.from("accounts").insert({ name: "Coinbase", institution: "Coinbase", account_type: "brokerage" }).select("id").single())).id;
}

/**
 * Sync one Coinbase connection (owned by `userId`) into its ledger account, in whatever
 * workspace that account lives. Works with the user's RLS-scoped client or the
 * service-role client (`asService`), and always scopes by the account explicitly. Idempotent: rows are keyed by Coinbase transaction id.
 */
export async function syncCoinbase(
  db: Db,
  conn: CoinbaseConnectionRow,
  userId: string,
  opts: { asService?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<SyncResult> {
  const result: SyncResult = {
    itemId: conn.id,
    institution: "Coinbase",
    added: 0,
    updated: 0,
    removed: 0,
    matchedExisting: 0,
    skipped: 0,
    recurringLinked: 0,
    ok: true,
  };
  try {
    const client = new CoinbaseClient({ keyName: conn.key_name, privateKey: decryptSecret(conn.private_key_enc) }, opts.fetchImpl);
    // Wallets first: it's the authenticated call, so a rejected key is reported as such.
    const wallets = await client.accounts();
    const rates = await client.usdRates();
    if (!conn.account_id) {
      throw new CoinbaseError("Coinbase isn't linked to a Ledger account any more. Use Replace key to choose one.", null);
    }
    const accountId = conn.account_id;
    const { workspace_id: workspaceId, track_transactions: trackTransactions } = await must(
      db.from("accounts").select("workspace_id, track_transactions").eq("id", accountId).single(),
    );

    // What we already hold, so paging can stop at the first page of known, settled history.
    const known = new Map<string, { id: string; status: string; amount: number; transaction_type: string }>();
    for (let from = 0; ; from += 1000) {
      const rows = await must(
        db
          .from("transactions")
          .select("id, coinbase_transaction_id, status, amount, transaction_type")
          .eq("account_id", accountId)
          .not("coinbase_transaction_id", "is", null)
          .order("id")
          .range(from, from + 999),
      );
      rows.forEach((r) => known.set(r.coinbase_transaction_id!, r));
      if (rows.length < 1000) break;
    }
    const stop = (page: CbTransaction[]) => page.some((t) => known.get(t.id)?.status === "posted") && !page.some((t) => known.get(t.id)?.status === "pending");

    const previous = asSnapshots(conn.wallets);
    // An account set to balance only skips reading transactions altogether.
    const poll = trackTransactions ? walletsToPoll(wallets, previous, conn.last_synced_at) : [];
    const fetched = await pool(poll, 4, async (w) => ({ wallet: w, txns: await client.transactions(w.id, stop) }));

    const inserts: TablesInsert<"transactions">[] = [];
    const updates: { id: string; patch: TablesUpdate<"transactions"> }[] = [];
    const deletes: string[] = [];
    const seen = new Set<string>();
    for (const { wallet, txns } of fetched) {
      for (const t of txns) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const m = mapCoinbaseTransaction(t, currencyCode(wallet.currency), rates);
        const have = known.get(t.id);
        if (!m) {
          // A pending send that later failed or was canceled.
          if (have?.status === "pending") deletes.push(have.id);
          else result.skipped++;
          continue;
        }
        if (have) {
          if (have.status !== m.status || Math.abs(have.amount - m.amount) >= 0.005) {
            updates.push({ id: have.id, patch: { status: m.status, posted_date: m.posted_date, transaction_date: m.transaction_date, amount: m.amount } });
          }
          continue;
        }
        inserts.push({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          account_id: accountId,
          ...m,
          currency: "USD",
          category_id: null,
          review_status: "unreviewed",
          external_transaction_id: m.coinbase_transaction_id,
        });
      }
    }

    // ---- Writes -------------------------------------------------------------
    for (const batch of chunk(inserts, 500)) await must(db.from("transactions").insert(batch));
    result.added = inserts.length;

    for (const u of updates) {
      const { error } = await db.from("transactions").update(u.patch).eq("id", u.id).eq("account_id", accountId);
      // A split parent can't change amount; keep the user's split and just record the rest.
      if (error && (error as { code?: string }).code === "23514") {
        const { amount: _amount, ...rest } = u.patch;
        void _amount;
        await must(db.from("transactions").update(rest).eq("id", u.id).eq("account_id", accountId));
      } else if (error) {
        throw error;
      }
    }
    result.updated = updates.length;

    for (const ids of chunk(deletes, 150)) {
      const gone = await must(db.from("transactions").delete().eq("account_id", accountId).in("id", ids).select("id"));
      result.removed += gone.length;
    }

    if (inserts.length) {
      for (const ids of chunk(
        inserts.map((i) => i.id!),
        2000,
      )) {
        if (opts.asService) await must(db.rpc("apply_categorization_rules_as", { p_user_id: userId, p_transaction_ids: ids }));
        else await must(db.rpc("apply_categorization_rules", { p_transaction_ids: ids, p_only_unreviewed: true, p_import_only: true }));
        result.recurringLinked += opts.asService
          ? await must(db.rpc("auto_link_recurring_as", { p_user_id: userId, p_transaction_ids: ids }))
          : await must(db.rpc("auto_link_recurring", { p_transaction_ids: ids }));
      }
    }

    // Balance: every wallet valued in USD at Coinbase's current rate.
    const hadActivity = new Set(fetched.filter((f) => f.txns.length).map((f) => f.wallet.id));
    const prevActive = new Set(previous.filter((w) => w.active).map((w) => w.id));
    const snapshots: WalletSnapshot[] = wallets.map((w) => {
      const usd = walletUsd(w, rates);
      return {
        id: w.id,
        currency: currencyCode(w.currency),
        name: w.name,
        balance: Number(w.balance.amount),
        usd: usd === null ? null : Math.round(usd * 100) / 100,
        active: hadActivity.has(w.id) || prevActive.has(w.id),
      };
    });
    const today = new Date().toISOString().slice(0, 10);
    await must(
      db
        .from("accounts")
        .update({ current_balance: totalUsd(snapshots), available_balance: null, balance_as_of: today })
        .eq("id", accountId),
    );

    await must(
      db
        .from("coinbase_connections")
        .update({ wallets: snapshots as unknown as Json, last_synced_at: new Date().toISOString(), status: "active", last_sync_error: null })
        .eq("id", conn.id)
        .eq("user_id", userId),
    );
    return result;
  } catch (err) {
    const cb = err instanceof CoinbaseError ? err : null;
    const message = cb ? cb.message : "Sync failed. Try again in a few minutes.";
    console.error("[coinbase-sync]", conn.id, cb?.status ?? "", (err as Error)?.message ?? err);
    await db
      .from("coinbase_connections")
      .update({ status: cb && cb.kind !== "other" ? "auth_failed" : "error", last_sync_error: message.slice(0, 1000) })
      .eq("id", conn.id)
      .eq("user_id", userId);
    return { ...result, ok: false, error: message };
  }
}
