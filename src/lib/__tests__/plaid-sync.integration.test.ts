/**
 * Integration test for the Plaid sync engine against a real Postgres + PostgREST-compatible
 * API (local dev stack). Plaid itself is replaced by a scripted /transactions/sync sequence.
 *
 * Runs only when LEDGER_TEST_SUPABASE_URL is set, e.g.
 *   LEDGER_TEST_SUPABASE_URL=http://localhost:54321 LEDGER_TEST_EMAIL=… LEDGER_TEST_PASSWORD=… npx vitest run plaid-sync
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/database.types";
import { signInToWorkspace } from "@/lib/__tests__/workspace-client";

vi.mock("server-only", () => ({}));
process.env.PLAID_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.PLAID_CLIENT_ID = "test";
process.env.PLAID_SECRET = "test";

const pages: Record<string, unknown> = {};
const liabilities: { response: unknown; error?: string } = { response: { liabilities: { credit: [] } } };
vi.mock("@/lib/server/plaid", () => ({
  plaid: () => ({
    liabilitiesGet: async () => {
      if (liabilities.error) throw Object.assign(new Error(liabilities.error), { response: { data: { error_code: liabilities.error } } });
      return { data: liabilities.response };
    },
    transactionsSync: async ({ cursor }: { cursor?: string }) => {
      const page = pages[cursor ?? "start"];
      if (!page) throw new Error(`unexpected cursor ${cursor}`);
      return { data: page };
    },
  }),
  plaidErrorCode: (e: { response?: { data?: { error_code?: string } } }) => e?.response?.data?.error_code,
  plaidErrorMessage: (e: Error) => e.message,
}));

const URL = process.env.LEDGER_TEST_SUPABASE_URL;
const run = URL ? describe : describe.skip;

const pfc = (primary: string, detailed: string) => ({ primary, detailed });
const txn = (o: Record<string, unknown>) => ({
  pending: false,
  pending_transaction_id: null,
  merchant_name: null,
  iso_currency_code: "USD",
  personal_finance_category: null,
  ...o,
});
const balances = (current: number, limit: number | null = null) => ({ current, available: null, limit, iso_currency_code: "USD" });

run("plaid sync engine", () => {
  let db: ReturnType<typeof createClient<Database>>;
  let userId = "";
  let checkingId = "";
  let itemRow: Database["public"]["Tables"]["plaid_items"]["Row"];

  beforeAll(async () => {
    ({ db, userId } = await signInToWorkspace(URL!, process.env.LEDGER_TEST_EMAIL!, process.env.LEDGER_TEST_PASSWORD!));
    await db.rpc("delete_all_my_data", { p_confirm: "DELETE" });

    const food = (await db.from("categories").insert({ name: "Food & Drink" }).select().single()).data!;
    await db.from("categories").insert([
      { name: "Coffee", parent_category_id: food.id },
      { name: "Groceries", parent_category_id: food.id },
    ]);
    const { encryptSecret } = await import("@/lib/server/crypto");
    itemRow = (
      await db
        .from("plaid_items")
        .insert({ item_id: `item-${Date.now()}`, access_token_enc: encryptSecret("access-sandbox-123"), institution_name: "Test Bank" })
        .select()
        .single()
    ).data!;
    checkingId = (
      await db
        .from("accounts")
        .insert({ name: "Checking", account_type: "checking", plaid_item_id: itemRow.id, plaid_account_id: `acc-chk-${Date.now()}`, sync_from: "2026-09-01" })
        .select()
        .single()
    ).data!.id;
    // History that came from a CSV import earlier: Plaid's copy of it must be matched, not duplicated.
    await db
      .from("transactions")
      .insert({ account_id: checkingId, transaction_date: "2026-09-28", merchant_name: "Trader Joe's", amount: -42.1, transaction_type: "expense" });
  });

  it("imports new charges, matches CSV overlap, maps categories, skips out-of-range and unmapped, updates balances", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    const acc = (await db.from("accounts").select("plaid_account_id").eq("id", checkingId).single()).data!.plaid_account_id!;
    pages.start = {
      added: [
        txn({
          transaction_id: "p1",
          account_id: acc,
          amount: 12.5,
          date: "2026-09-30",
          name: "BLUE BOTTLE COFFEE",
          pending: true,
          personal_finance_category: pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"),
        }),
        txn({ transaction_id: "t2", account_id: acc, amount: 42.1, date: "2026-09-29", name: "TRADER JOE S #123" }),
        txn({
          transaction_id: "t3",
          account_id: acc,
          amount: -2000,
          date: "2026-09-15",
          name: "ACME PAYROLL",
          personal_finance_category: pfc("INCOME", "INCOME_WAGES"),
        }),
        txn({ transaction_id: "t4", account_id: acc, amount: 9.99, date: "2026-08-15", name: "OLD CHARGE" }),
        txn({ transaction_id: "t5", account_id: "unmapped-account", amount: 5, date: "2026-09-20", name: "ELSEWHERE" }),
      ],
      modified: [],
      removed: [],
      accounts: [{ account_id: acc, name: "Checking", mask: "1234", type: "depository", subtype: "checking", balances: balances(5123.45) }],
      next_cursor: "c1",
      has_more: false,
    };
    const r = await syncItem(db, itemRow, userId);
    expect(r).toMatchObject({ ok: true, added: 2, matchedExisting: 1, skipped: 2 });

    const rows = (await db.from("transactions").select("*").eq("account_id", checkingId).order("transaction_date")).data!;
    expect(rows).toHaveLength(3);
    const coffee = rows.find((t) => t.plaid_transaction_id === "p1")!;
    expect(coffee).toMatchObject({
      amount: -12.5,
      status: "pending",
      merchant_name: "Blue bottle coffee",
      review_status: "unreviewed",
      transaction_type: "expense",
    });
    const coffeeCat = (await db.from("categories").select("name").eq("id", coffee.category_id!).single()).data!;
    expect(coffeeCat.name).toBe("Coffee");
    expect(rows.find((t) => t.plaid_transaction_id === "t3")).toMatchObject({ amount: 2000, transaction_type: "income" });
    expect(rows.find((t) => t.merchant_name === "Trader Joe's")).toMatchObject({ plaid_transaction_id: "t2", amount: -42.1 });

    const account = (await db.from("accounts").select("current_balance, balance_as_of").eq("id", checkingId).single()).data!;
    expect(account.current_balance).toBe(5123.45);
    const item = (await db.from("plaid_items").select("cursor, status, last_synced_at").eq("id", itemRow.id).single()).data!;
    expect(item).toMatchObject({ cursor: "c1", status: "active" });
    itemRow = { ...itemRow, cursor: "c1" };
  });

  it("replaces a pending charge with its posted version and keeps the user's edits; applies modifications", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    const acc = (await db.from("accounts").select("plaid_account_id").eq("id", checkingId).single()).data!.plaid_account_id!;
    const pending = (await db.from("transactions").select("id").eq("plaid_transaction_id", "p1").single()).data!;
    await db.from("transactions").update({ notes: "with Sam", review_status: "reviewed" }).eq("id", pending.id);

    pages.c1 = {
      added: [txn({ transaction_id: "t6", pending_transaction_id: "p1", account_id: acc, amount: 12.75, date: "2026-10-01", name: "BLUE BOTTLE COFFEE" })],
      modified: [txn({ transaction_id: "t3", account_id: acc, amount: -2001, date: "2026-09-15", name: "ACME PAYROLL" })],
      removed: [],
      accounts: [],
      next_cursor: "c2",
      has_more: false,
    };
    const r = await syncItem(db, itemRow, userId);
    expect(r).toMatchObject({ ok: true, added: 0, updated: 2 });
    const posted = (await db.from("transactions").select("*").eq("id", pending.id).single()).data!;
    expect(posted).toMatchObject({
      plaid_transaction_id: "t6",
      amount: -12.75,
      status: "posted",
      transaction_date: "2026-10-01",
      notes: "with Sam",
      review_status: "reviewed",
    });
    const pay = (await db.from("transactions").select("amount").eq("plaid_transaction_id", "t3").single()).data!;
    expect(pay.amount).toBe(2001);
    itemRow = { ...itemRow, cursor: "c2" };
  });

  it("deletes transactions the bank removed, and replaying a page is idempotent", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    pages.c2 = { added: [], modified: [], removed: [{ transaction_id: "t6" }], accounts: [], next_cursor: "c3", has_more: false };
    const r = await syncItem(db, itemRow, userId);
    expect(r).toMatchObject({ ok: true, removed: 1 });
    expect((await db.from("transactions").select("id").eq("plaid_transaction_id", "t6")).data).toHaveLength(0);

    // Replaying the first page (e.g. after a crash before the cursor saved) must not duplicate anything.
    const before = (await db.from("transactions").select("id").eq("account_id", checkingId)).data!.length;
    const replay = await syncItem(db, { ...itemRow, cursor: null }, userId);
    expect(replay.ok).toBe(true);
    const after = (await db.from("transactions").select("id").eq("account_id", checkingId)).data!.length;
    expect(after).toBe(before + 1); // p1 reappears as pending (it was removed after posting) — no duplicates of t2/t3
    expect((await db.from("transactions").select("id").eq("plaid_transaction_id", "t3")).data).toHaveLength(1);
    expect((await db.from("transactions").select("id").eq("plaid_transaction_id", "t2")).data).toHaveLength(1);
  });

  it("fills card statement balance, due date and close date from Liabilities", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    const plaidCard = `acc-card-${Date.now()}`;
    const cardId = (
      await db
        .from("accounts")
        .insert({ name: "Sapphire", account_type: "credit_card", plaid_item_id: itemRow.id, plaid_account_id: plaidCard, minimum_payment: 25 })
        .select()
        .single()
    ).data!.id;
    const item = (await db.from("plaid_items").select("*").eq("id", itemRow.id).single()).data!;
    pages[item.cursor!] = { added: [], modified: [], removed: [], accounts: [], next_cursor: item.cursor, has_more: false };

    liabilities.error = "ADDITIONAL_CONSENT_REQUIRED";
    expect((await syncItem(db, item, userId)).ok).toBe(true);
    expect((await db.from("plaid_items").select("liabilities_status").eq("id", item.id).single()).data!.liabilities_status).toBe("consent_required");

    liabilities.error = undefined;
    liabilities.response = {
      liabilities: {
        credit: [
          {
            account_id: plaidCard,
            last_statement_balance: 1240.18,
            last_statement_issue_date: "2026-09-25",
            minimum_payment_amount: null,
            next_payment_due_date: "2026-10-22",
            last_payment_amount: 980,
            last_payment_date: "2026-09-20",
            is_overdue: false,
            aprs: [],
          },
        ],
      },
    };
    const r = await syncItem(db, item, userId);
    expect(r).toMatchObject({ ok: true, statementsUpdated: 1 });
    const acct = (await db.from("accounts").select("*").eq("id", cardId).single()).data!;
    expect(acct).toMatchObject({
      statement_balance: 1240.18,
      next_payment_due_date: "2026-10-22",
      payment_due_day: 22,
      last_statement_date: "2026-09-25",
      statement_close_day: 25,
      last_payment_amount: 980,
      is_overdue: false,
      minimum_payment: 25, // not reported, so the hand-entered value stays
    });
    expect((await db.from("plaid_items").select("liabilities_status").eq("id", item.id).single()).data!.liabilities_status).toBe("ok");
  });

  it("feeds an account in another workspace with that workspace's categories and rules, out of sight of the first", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    // A business workspace whose chart of accounts has "Software & Subscriptions" and a rule for Figma.
    const { data: bizId } = await db.rpc("create_workspace", { p_name: `Biz ${Date.now()}`, p_kind: "business" });
    const all = createClient<Database>(URL!, "local-anon", { auth: { persistSession: false }, global: { headers: { "x-workspace-id": "all" } } });
    const session = (await db.auth.getSession()).data.session!;
    await all.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    const software = (await all.from("categories").select("id").eq("workspace_id", bizId!).eq("name", "Software & Subscriptions").single()).data!.id;
    await all.from("categorization_rules").insert({
      workspace_id: bizId!,
      name: "Figma",
      conditions: [{ field: "merchant", op: "contains", value: "figma" }],
      actions: { category_id: software },
    });
    const bizCard = `acc-biz-${Date.now()}`;
    const bizAcct = (
      await all
        .from("accounts")
        .insert({ workspace_id: bizId!, name: "Biz Card", account_type: "credit_card", plaid_item_id: itemRow.id, plaid_account_id: bizCard })
        .select()
        .single()
    ).data!;
    expect(bizAcct.workspace_id).toBe(bizId);

    const item = (await all.from("plaid_items").select("*").eq("id", itemRow.id).single()).data!;
    liabilities.response = { liabilities: { credit: [] } };
    pages[item.cursor!] = {
      added: [txn({ transaction_id: "biz1", account_id: bizCard, amount: 45, date: "2026-10-02", name: "FIGMA MONTHLY" })],
      modified: [],
      removed: [],
      accounts: [],
      next_cursor: `${item.cursor}-biz`,
      has_more: false,
    };
    const r = await syncItem(all, item, userId);
    expect(r).toMatchObject({ ok: true, added: 1 });

    const biz = (await all.from("transactions").select("workspace_id, category_id, amount").eq("plaid_transaction_id", "biz1").single()).data!;
    expect(biz).toMatchObject({ workspace_id: bizId, category_id: software, amount: -45 });
    // The personal workspace's client doesn't see it.
    expect((await db.from("transactions").select("id").eq("plaid_transaction_id", "biz1")).data).toEqual([]);
    await db.rpc("delete_workspace", {
      p_workspace_id: bizId!,
      p_confirm_name: (await all.from("workspaces").select("name").eq("id", bizId!).single()).data!.name,
    });
  });

  it("keeps a bank account mirrored into a second workspace in sync in both", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    const { data: bizId } = await db.rpc("create_workspace", { p_name: `Mirror ${Date.now()}`, p_kind: "business" });
    const all = createClient<Database>(URL!, "local-anon", { auth: { persistSession: false }, global: { headers: { "x-workspace-id": "all" } } });
    const session = (await db.auth.getSession()).data.session!;
    await all.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });

    const card = (await db.from("accounts").select("id, plaid_account_id").eq("name", "Sapphire").single()).data!;
    const checking = (await db.from("accounts").select("plaid_account_id").eq("id", checkingId).single()).data!;
    const { data: checkingCopy, error: copyErr } = await db.rpc("copy_account_to_workspace", { p_account_id: checkingId, p_target_ws: bizId! });
    expect(copyErr).toBeNull();
    const { data: cardCopy } = await db.rpc("copy_account_to_workspace", { p_account_id: card.id, p_target_ws: bizId! });
    const history = (await db.from("transactions").select("id").eq("account_id", checkingId)).data!.length;
    expect((await all.from("transactions").select("id").eq("account_id", checkingCopy!)).data).toHaveLength(history);
    // The same bank account can't be added to a workspace twice.
    expect((await db.rpc("copy_account_to_workspace", { p_account_id: checkingId, p_target_ws: bizId! })).error).toBeTruthy();

    const item = (await all.from("plaid_items").select("*").eq("id", itemRow.id).single()).data!;
    liabilities.error = undefined;
    liabilities.response = {
      liabilities: { credit: [{ account_id: card.plaid_account_id, last_statement_balance: 310.5, next_payment_due_date: "2026-11-03", aprs: [] }] },
    };
    pages[item.cursor!] = {
      added: [txn({ transaction_id: "m1", account_id: checking.plaid_account_id, amount: 18, date: "2026-10-03", name: "LUNCH SPOT" })],
      modified: [txn({ transaction_id: "t3", account_id: checking.plaid_account_id, amount: -2002, date: "2026-09-15", name: "ACME PAYROLL" })],
      removed: [{ transaction_id: "t2" }],
      accounts: [{ account_id: checking.plaid_account_id, name: "Checking", mask: "1234", type: "depository", subtype: "checking", balances: balances(777) }],
      next_cursor: `${item.cursor}-mirror`,
      has_more: false,
    };
    const r = await syncItem(all, item, userId);
    expect(r).toMatchObject({ ok: true, added: 2, removed: 2, statementsUpdated: 1 });

    for (const [accountId, ws] of [
      [checkingId, null],
      [checkingCopy!, bizId!],
    ] as const) {
      const rows = (await all.from("transactions").select("plaid_transaction_id, amount, workspace_id").eq("account_id", accountId)).data!;
      expect(rows.filter((t) => t.plaid_transaction_id === "m1")).toHaveLength(1);
      expect(rows.find((t) => t.plaid_transaction_id === "t3")!.amount).toBe(2002);
      expect(rows.some((t) => t.plaid_transaction_id === "t2")).toBe(false);
      if (ws) expect(rows.every((t) => t.workspace_id === ws)).toBe(true);
      expect((await all.from("accounts").select("current_balance").eq("id", accountId).single()).data!.current_balance).toBe(777);
    }
    for (const id of [card.id, cardCopy!]) {
      expect((await all.from("accounts").select("statement_balance, next_payment_due_date").eq("id", id).single()).data).toMatchObject({
        statement_balance: 310.5,
        next_payment_due_date: "2026-11-03",
      });
    }

    // Removing one workspace's copy leaves the other; the last copy can't be removed this way.
    expect((await db.rpc("remove_account_copy", { p_account_id: checkingCopy! })).error).toBeNull();
    expect((await db.rpc("remove_account_copy", { p_account_id: checkingId })).error).toBeTruthy();
    expect((await db.from("transactions").select("id").eq("account_id", checkingId)).data!.length).toBe(history);
    await db.rpc("delete_workspace", {
      p_workspace_id: bizId!,
      p_confirm_name: (await all.from("workspaces").select("name").eq("id", bizId!).single()).data!.name,
    });
  });

  it("records login-required errors on the connection instead of throwing", async () => {
    const { syncItem } = await import("@/lib/server/plaid-sync");
    const r = await syncItem(db, { ...itemRow, cursor: "missing-cursor" }, userId);
    expect(r.ok).toBe(false);
    const item = (await db.from("plaid_items").select("status, last_sync_error").eq("id", itemRow.id).single()).data!;
    expect(item.status).toBe("error");
    expect(item.last_sync_error).toBeTruthy();
  });
});
