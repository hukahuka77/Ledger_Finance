/**
 * Integration test for the Coinbase sync engine against a real Postgres + PostgREST-compatible
 * API (local dev stack). Coinbase itself is replaced by a scripted fetch.
 *
 * Runs only when LEDGER_TEST_SUPABASE_URL is set, e.g.
 *   LEDGER_TEST_SUPABASE_URL=http://localhost:54321 LEDGER_TEST_EMAIL=… LEDGER_TEST_PASSWORD=… npx vitest run coinbase-sync
 */
import { generateKeyPairSync } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { signInToWorkspace } from "@/lib/__tests__/workspace-client";

vi.mock("server-only", () => ({}));
process.env.PLAID_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

const URL = process.env.LEDGER_TEST_SUPABASE_URL;
const run = URL ? describe : describe.skip;

type Txn = Record<string, unknown>;
const state: { wallets: Txn[]; txns: Record<string, Txn[]>; calls: string[] } = { wallets: [], txns: {}, calls: [] };
const rates = { BTC: "0.00001", ETH: "0.0004", USDC: "1" };

/** Fake api.coinbase.com: pages of 2 so pagination and early stop are exercised. */
const fetchImpl = (async (input: string) => {
  const u = new globalThis.URL(input);
  state.calls.push(u.pathname + u.search);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  if (u.pathname === "/v2/exchange-rates") return json({ data: { currency: "USD", rates } });
  if (u.pathname === "/v2/accounts") return json({ data: state.wallets, pagination: { next_uri: null } });
  const m = u.pathname.match(/^\/v2\/accounts\/([^/]+)\/transactions$/);
  if (m) {
    const all = state.txns[m[1]] ?? [];
    const start = Number(u.searchParams.get("page") ?? 0);
    const next = start + 2 < all.length ? `/v2/accounts/${m[1]}/transactions?page=${start + 2}` : null;
    return json({ data: all.slice(start, start + 2), pagination: { next_uri: next } });
  }
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const wallet = (id: string, code: string, balance: string, updated = "2026-09-01T00:00:00Z") => ({
  id,
  name: `${code} Wallet`,
  currency: { code },
  balance: { amount: balance, currency: code },
  updated_at: updated,
});
const t = (id: string, type: string, amount: string, code: string, usd: string, date: string, extra: Txn = {}) => ({
  id,
  type,
  status: "completed",
  amount: { amount, currency: code },
  native_amount: { amount: usd, currency: "USD" },
  created_at: `${date}T15:00:00Z`,
  ...extra,
});

run("coinbase sync engine", () => {
  let db: ReturnType<typeof createClient<Database>>;
  let userId = "";
  let conn: Database["public"]["Tables"]["coinbase_connections"]["Row"];

  beforeAll(async () => {
    ({ db, userId } = await signInToWorkspace(URL!, process.env.LEDGER_TEST_EMAIL!, process.env.LEDGER_TEST_PASSWORD!));
    await db.from("coinbase_connections").delete().eq("user_id", userId);
    await db.rpc("delete_all_my_data", { p_confirm: "DELETE" });
    await db.from("recurring_items").insert({
      name: "Netflix",
      merchant_pattern: "netflix",
      match_patterns: ["netflix"],
      expected_amount: 15.49,
      frequency: "monthly",
      next_expected_date: "2026-10-12",
    });

    const { encryptSecret } = await import("@/lib/server/crypto");
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "sec1", format: "pem" }).toString();
    // As the connect route does: roll Coinbase into a "Coinbase" account in the open workspace.
    const { findOrCreateCoinbaseAccount } = await import("@/lib/server/coinbase-sync");
    const accountId = await findOrCreateCoinbaseAccount(db);
    conn = (
      await db
        .from("coinbase_connections")
        .insert({ key_name: "organizations/o/apiKeys/k", private_key_enc: encryptSecret(pem), account_id: accountId })
        .select()
        .single()
    ).data!;
  });

  it("first sync reads every wallet, values the account in USD and links recurring", async () => {
    state.wallets = [wallet("w-btc", "BTC", "0.01"), wallet("w-usdc", "USDC", "50"), wallet("w-eth", "ETH", "0")];
    state.txns = {
      "w-btc": [
        t("b3", "send", "-0.002", "BTC", "-200.00", "2026-09-20", { status: "pending" }),
        t("b2", "buy", "0.007", "BTC", "700.00", "2026-09-10"),
        t("b1", "buy", "0.005", "BTC", "500.00", "2026-09-02"),
      ],
      "w-usdc": [
        t("u3", "card_spend", "-15.49", "USDC", "-15.49", "2026-09-12", { details: { title: "Netflix.com" } }),
        t("u2", "interest", "0.21", "USDC", "0.21", "2026-09-05"),
        t("u1", "fiat_deposit", "65.28", "USDC", "65.28", "2026-09-01"),
      ],
      "w-eth": [],
    };
    const { syncCoinbase } = await import("@/lib/server/coinbase-sync");
    const r = await syncCoinbase(db, conn, userId, { fetchImpl });
    expect(r).toMatchObject({ ok: true, added: 6, institution: "Coinbase", recurringLinked: 1 });
    expect(state.calls.filter((c) => c.includes("/w-eth/"))).toHaveLength(1);

    conn = (await db.from("coinbase_connections").select("*").eq("id", conn.id).single()).data!;
    expect(conn.status).toBe("active");
    const acct = (await db.from("accounts").select("*").eq("id", conn.account_id!).single()).data!;
    expect(acct).toMatchObject({ name: "Coinbase", account_type: "brokerage", current_balance: 1050 });

    const rows = (await db.from("transactions").select("*").eq("account_id", acct.id).order("transaction_date")).data!;
    expect(rows.map((x) => [x.coinbase_transaction_id, x.transaction_type, x.amount, x.status])).toEqual([
      ["u1", "transfer", 65.28, "posted"],
      ["b1", "transfer", 500, "posted"],
      ["u2", "income", 0.21, "posted"],
      ["b2", "transfer", 700, "posted"],
      ["u3", "expense", -15.49, "posted"],
      ["b3", "transfer", -200, "pending"],
    ]);
    expect(rows.find((x) => x.coinbase_transaction_id === "u3")!.recurring_item_id).not.toBeNull();
    expect(rows.find((x) => x.coinbase_transaction_id === "b2")!.merchant_name).toBe("Buy BTC");
  });

  it("later syncs skip idle wallets, stop at known history, settle pending and drop canceled", async () => {
    state.calls = [];
    state.wallets = [wallet("w-btc", "BTC", "0.008"), wallet("w-usdc", "USDC", "34.51"), wallet("w-eth", "ETH", "0")];
    state.txns["w-btc"] = [
      t("b4", "sell", "-0.001", "BTC", "-101.00", "2026-09-28"),
      t("b3", "send", "-0.002", "BTC", "-198.40", "2026-09-20"),
      t("b2", "buy", "0.007", "BTC", "700.00", "2026-09-10"),
      t("b1", "buy", "0.005", "BTC", "500.00", "2026-09-02"),
    ];
    const { syncCoinbase } = await import("@/lib/server/coinbase-sync");
    const r = await syncCoinbase(db, conn, userId, { fetchImpl });
    expect(r).toMatchObject({ ok: true, added: 1, updated: 1, removed: 0 });
    // ETH has no balance, no history and hasn't changed: not polled. BTC pages past b4/b3 (b3 was pending)
    // and stops at the page of settled, known b2/b1.
    expect(state.calls.some((c) => c.includes("/w-eth/"))).toBe(false);
    expect(state.calls.filter((c) => c.includes("/w-btc/"))).toHaveLength(2);
    expect(state.calls.filter((c) => c.includes("/w-usdc/"))).toHaveLength(1);

    const b3 = (await db.from("transactions").select("*").eq("coinbase_transaction_id", "b3").single()).data!;
    expect(b3).toMatchObject({ status: "posted", amount: -198.4, posted_date: "2026-09-20" });
    const acct = (await db.from("accounts").select("current_balance").eq("id", conn.account_id!).single()).data!;
    expect(acct.current_balance).toBe(834.51);

    // A pending send that gets canceled disappears.
    conn = (await db.from("coinbase_connections").select("*").eq("id", conn.id).single()).data!;
    state.txns["w-btc"] = [t("b5", "send", "-0.001", "BTC", "-100.00", "2026-09-30", { status: "pending" }), ...state.txns["w-btc"]];
    expect(await syncCoinbase(db, conn, userId, { fetchImpl })).toMatchObject({ added: 1 });
    state.txns["w-btc"][0] = { ...state.txns["w-btc"][0], status: "canceled" };
    expect(await syncCoinbase(db, conn, userId, { fetchImpl })).toMatchObject({ ok: true, removed: 1 });
    expect((await db.from("transactions").select("id").eq("coinbase_transaction_id", "b5")).data).toEqual([]);
  });

  it("marks the connection when Coinbase rejects the key", async () => {
    const denied = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const { syncCoinbase } = await import("@/lib/server/coinbase-sync");
    const r = await syncCoinbase(db, conn, userId, { fetchImpl: denied });
    expect(r.ok).toBe(false);
    expect((await db.from("coinbase_connections").select("status").eq("id", conn.id).single()).data!.status).toBe("auth_failed");
  });
});
