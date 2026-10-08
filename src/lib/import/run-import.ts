import type { Json, TablesInsert } from "@/lib/database.types";
import type { Account, AccountType, Category, RecurringType } from "@/lib/domain";
import { stepDate, toISODate, fromISODate } from "@/lib/dates";
import { SWATCHES } from "@/lib/domain";
import type { ColumnMapping, ImportOptions, NormalizedRow } from "@/lib/import/csv";
import { inferFrequency, resolveType } from "@/lib/import/csv";
import { getSupabase } from "@/lib/supabase/client";

export type AccountTarget = { kind: "existing"; id: string } | { kind: "new"; name: string; type: AccountType; lastFour: string };
export type CategoryTarget = { kind: "existing"; id: string } | { kind: "new" } | { kind: "none" };

export interface AccountPlan {
  key: string;
  name: string;
  mask: string;
  rows: number;
  target: AccountTarget;
}
export interface CategoryPlan {
  key: string;
  name: string;
  parent: string;
  rows: number;
  target: CategoryTarget;
}

export type RowDecision = "import" | "skip";
export interface RowState {
  row: NormalizedRow;
  hash: string;
  dup: "none" | "exact" | "possible";
  decision: RowDecision;
}

export interface ImportPlan {
  filename: string;
  fileSize: number;
  mapping: ColumnMapping;
  options: ImportOptions;
  accounts: AccountPlan[];
  categories: CategoryPlan[];
  rows: RowState[];
  createRecurring: boolean;
}

export interface ImportResult {
  importId: string;
  imported: number;
  duplicates: number;
  skipped: number;
  errors: number;
  accountsCreated: number;
  categoriesCreated: number;
  recurringCreated: number;
  rulesApplied: number;
  recurringLinked: number;
}

type Progress = (stage: string, done: number, total: number) => void;

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

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await must(build(from, from + pageSize - 1));
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

/**
 * Detect duplicates against existing data:
 *  - exact:    same import fingerprint already stored
 *  - possible: an existing transaction in the same account on the same date for the same amount
 */
export async function detectDuplicates(rows: { row: NormalizedRow; hash: string }[], accountIdByKey: Map<string, string>): Promise<RowState[]> {
  const sb = getSupabase();
  const valid = rows.filter((r) => r.row.errors.length === 0);
  const existingIds = [...new Set(valid.map((r) => accountIdByKey.get(r.row.accountKey)).filter(Boolean) as string[])];
  const hashes = new Set<string>();
  const fuzzy = new Map<string, number>();

  if (existingIds.length && valid.length) {
    const dates = valid.map((r) => r.row.date).sort();
    const existing = await fetchAll<{ account_id: string; transaction_date: string; amount: number; import_hash: string | null }>((a, b) =>
      sb
        .from("transactions")
        .select("account_id, transaction_date, amount, import_hash")
        .in("account_id", existingIds)
        .gte("transaction_date", dates[0])
        .lte("transaction_date", dates[dates.length - 1])
        .order("id")
        .range(a, b),
    );
    for (const e of existing) {
      if (e.import_hash) hashes.add(e.import_hash);
      const k = `${e.account_id}|${e.transaction_date}|${Math.round(e.amount * 100)}`;
      fuzzy.set(k, (fuzzy.get(k) ?? 0) + 1);
    }
  }

  return rows.map(({ row, hash }) => {
    if (row.errors.length) return { row, hash, dup: "none", decision: "skip" };
    if (hashes.has(hash)) return { row, hash, dup: "exact", decision: "skip" };
    const acct = accountIdByKey.get(row.accountKey);
    if (acct) {
      const k = `${acct}|${row.date}|${Math.round(row.amount * 100)}`;
      const n = fuzzy.get(k) ?? 0;
      if (n > 0) {
        fuzzy.set(k, n - 1);
        return { row, hash, dup: "possible", decision: "skip" };
      }
    }
    return { row, hash, dup: "none", decision: "import" };
  });
}

export async function runImport(plan: ImportPlan, existingAccounts: Account[], existingCategories: Category[], onProgress: Progress): Promise<ImportResult> {
  const sb = getSupabase();
  const toImport = plan.rows.filter((r) => r.decision === "import" && r.row.errors.length === 0);
  const errorCount = plan.rows.filter((r) => r.row.errors.length > 0).length;
  const dupSkipped = plan.rows.filter((r) => r.row.errors.length === 0 && r.decision === "skip" && r.dup !== "none").length;
  const otherSkipped = plan.rows.filter((r) => r.row.errors.length === 0 && r.decision === "skip" && r.dup === "none").length;

  const imp = await must(
    sb
      .from("imports")
      .insert({
        filename: plan.filename.slice(0, 255),
        file_size: plan.fileSize,
        row_count: plan.rows.length,
        column_mapping: plan.mapping as unknown as Json,
        options: plan.options as unknown as Json,
        status: "in_progress",
      })
      .select("id")
      .single(),
  );
  const importId = imp.id;

  try {
    // ---- Accounts ---------------------------------------------------------
    onProgress("Creating accounts", 0, 1);
    const accountId = new Map<string, string>();
    const accountType = new Map<string, AccountType>();
    existingAccounts.forEach((a) => accountType.set(a.id, a.account_type as AccountType));
    const newAccounts = plan.accounts.filter((a) => a.target.kind === "new");
    for (const a of plan.accounts) if (a.target.kind === "existing") accountId.set(a.key, a.target.id);
    if (newAccounts.length) {
      const created = await must(
        sb
          .from("accounts")
          .insert(
            newAccounts.map((a, i) => {
              const t = a.target as Extract<AccountTarget, { kind: "new" }>;
              return {
                name: t.name.trim().slice(0, 120) || a.name,
                account_type: t.type,
                last_four: t.lastFour || null,
                sort_order: i,
              } satisfies TablesInsert<"accounts">;
            }),
          )
          .select("id, name, last_four, account_type"),
      );
      newAccounts.forEach((a) => {
        const t = a.target as Extract<AccountTarget, { kind: "new" }>;
        const hit = created.find((c) => c.name === (t.name.trim().slice(0, 120) || a.name) && (c.last_four ?? "") === (t.lastFour || ""));
        if (hit) {
          accountId.set(a.key, hit.id);
          accountType.set(hit.id, hit.account_type as AccountType);
        }
      });
    }

    // ---- Categories -------------------------------------------------------
    onProgress("Creating categories", 0, 1);
    const categoryId = new Map<string, string>();
    const catType = new Map<string, string>();
    existingCategories.forEach((c) => catType.set(c.id, c.category_type));
    for (const c of plan.categories) if (c.target.kind === "existing") categoryId.set(c.key, c.target.id);
    const newCats = plan.categories.filter((c) => c.target.kind === "new");
    let categoriesCreated = 0;
    if (newCats.length) {
      const topByName = new Map(existingCategories.filter((c) => !c.parent_category_id).map((c) => [c.name.toLowerCase(), c]));
      // Parents needed by new subcategories (or new top-level categories themselves).
      const neededParents = [...new Set(newCats.map((c) => c.parent).filter(Boolean))].filter((p) => !topByName.has(p.toLowerCase()));
      const topLevelNew = newCats.filter((c) => !c.parent && !topByName.has(c.name.toLowerCase()));
      const parentNames = [...new Set([...neededParents, ...topLevelNew.map((c) => c.name)])];
      if (parentNames.length) {
        const created = await must(
          sb
            .from("categories")
            .insert(parentNames.map((name, i) => ({ name: name.slice(0, 80), color: SWATCHES[i % SWATCHES.length], sort_order: 1000 + i * 10 })))
            .select("*"),
        );
        categoriesCreated += created.length;
        created.forEach((c) => {
          topByName.set(c.name.toLowerCase(), c);
          catType.set(c.id, c.category_type);
        });
      }
      // Reuse subcategories that already exist under the resolved parent.
      const children = newCats.filter((c) => {
        if (!c.parent) return false;
        const parent = topByName.get(c.parent.toLowerCase())!;
        const hit = existingCategories.find((x) => x.parent_category_id === parent.id && x.name.toLowerCase() === c.name.slice(0, 80).toLowerCase());
        if (hit) categoryId.set(c.key, hit.id);
        return !hit;
      });
      if (children.length) {
        const created = await must(
          sb
            .from("categories")
            .insert(
              children.map((c, i) => {
                const parent = topByName.get(c.parent.toLowerCase())!;
                return { name: c.name.slice(0, 80), parent_category_id: parent.id, color: parent.color, sort_order: i };
              }),
            )
            .select("*"),
        );
        categoriesCreated += created.length;
        children.forEach((c) => {
          const parent = topByName.get(c.parent.toLowerCase())!;
          const hit = created.find((x) => x.parent_category_id === parent.id && x.name.toLowerCase() === c.name.slice(0, 80).toLowerCase());
          if (hit) {
            categoryId.set(c.key, hit.id);
            catType.set(hit.id, hit.category_type);
          }
        });
      }
      newCats
        .filter((c) => !c.parent)
        .forEach((c) => {
          const hit = topByName.get(c.name.toLowerCase());
          if (hit) categoryId.set(c.key, hit.id);
        });
    }

    // ---- Tags -------------------------------------------------------------
    const tagNames = [...new Set(toImport.flatMap((r) => r.row.tags))];
    const tagId = new Map<string, string>();
    if (tagNames.length) {
      onProgress("Creating tags", 0, 1);
      const existing = await must(sb.from("tags").select("id, name"));
      existing.forEach((t) => tagId.set(t.name.toLowerCase(), t.id));
      const missing = tagNames.filter((n) => !tagId.has(n.toLowerCase()));
      if (missing.length) {
        const created = await must(
          sb
            .from("tags")
            .insert(missing.map((name) => ({ name })))
            .select("id, name"),
        );
        created.forEach((t) => tagId.set(t.name.toLowerCase(), t.id));
      }
    }

    // ---- Recurring items (from a "recurring" column) ----------------------
    const recurringId = new Map<string, string>();
    let recurringCreated = 0;
    if (plan.createRecurring) {
      const byName = new Map<string, RowState[]>();
      toImport.forEach((r) => {
        if (!r.row.recurring) return;
        const k = r.row.recurring.toLowerCase();
        byName.set(k, [...(byName.get(k) ?? []), r]);
      });
      if (byName.size) {
        onProgress("Creating recurring items", 0, 1);
        const existing = await must(sb.from("recurring_items").select("id, name"));
        existing.forEach((e) => recurringId.set(e.name.toLowerCase(), e.id));
        const inserts: TablesInsert<"recurring_items">[] = [];
        const today = fromISODate(toISODate(new Date()));
        byName.forEach((items, k) => {
          if (recurringId.has(k)) return;
          const sorted = [...items].sort((a, b) => a.row.date.localeCompare(b.row.date));
          const { frequency, interval } = inferFrequency(sorted.map((s) => s.row.date));
          const last = sorted[sorted.length - 1].row;
          const recent = sorted
            .slice(-3)
            .map((s) => Math.abs(s.row.amount))
            .sort((a, b) => a - b);
          const amount = recent[Math.floor(recent.length / 2)];
          const variable = new Set(sorted.slice(-6).map((s) => Math.round(Math.abs(s.row.amount) * 100))).size > 1;
          // A schedule whose last payment is more than ~2.5 cycles old has most likely ended.
          const cycleDays = (stepDate(fromISODate(last.date), frequency, interval).getTime() - fromISODate(last.date).getTime()) / 86_400_000;
          const stale = (today.getTime() - fromISODate(last.date).getTime()) / 86_400_000 > cycleDays * 2.5;
          let next = stepDate(fromISODate(last.date), frequency, interval);
          let guard = 0;
          while (next < today && guard++ < 520) next = stepDate(next, frequency, interval);
          const acct = accountId.get(last.accountKey) ?? null;
          const cat = last.categoryKey ? (categoryId.get(last.categoryKey) ?? null) : null;
          const catName = last.categoryName.toLowerCase();
          const type: RecurringType =
            last.amount > 0 ? "income" : /subscri|stream|software/.test(catName) ? "subscription" : /loan/.test(catName) ? "loan" : "bill";
          inserts.push({
            name: last.recurring.slice(0, 120),
            merchant_pattern: last.merchant.slice(0, 200),
            match_patterns: [last.merchant.slice(0, 200)],
            recurring_type: type,
            expected_amount: amount,
            amount_type: variable ? "estimated" : "fixed",
            frequency,
            interval_value: frequency === "custom" ? interval : 1,
            next_expected_date: toISODate(next),
            account_id: acct,
            category_id: cat,
            active: !stale,
          });
        });
        if (inserts.length) {
          const created = await must(sb.from("recurring_items").insert(inserts).select("id, name"));
          recurringCreated = created.length;
          created.forEach((c) => recurringId.set(c.name.toLowerCase(), c.id));
        }
      }
    }

    // ---- Transactions -----------------------------------------------------
    const txIds: string[] = [];
    const tagLinks: { transaction_id: string; tag_id: string }[] = [];
    const rowTxn = new Map<number, string>();
    const hasType = Boolean(plan.mapping.type);
    const inserts: TablesInsert<"transactions">[] = toImport.map((r) => {
      const row = r.row;
      const acct = accountId.get(row.accountKey)!;
      const cat = row.categoryKey ? (categoryId.get(row.categoryKey) ?? null) : null;
      const id = crypto.randomUUID();
      txIds.push(id);
      rowTxn.set(row.rowNumber, id);
      row.tags.forEach((t) => {
        const tid = tagId.get(t.toLowerCase());
        if (tid) tagLinks.push({ transaction_id: id, tag_id: tid });
      });
      const type = resolveType(row, accountType.get(acct), hasType, cat ? catType.get(cat) : undefined);
      return {
        id,
        account_id: acct,
        transaction_date: row.date,
        merchant_name: row.merchant,
        original_description: row.description || row.merchant,
        amount: row.amount,
        transaction_type: type,
        category_id: cat,
        status: row.status,
        review_status: plan.options.reviewedBefore && row.date < plan.options.reviewedBefore ? "reviewed" : "unreviewed",
        // Apps like Copilot flag income and transfers as "excluded" (from spending). Those types are
        // already kept out of spending here, and income must still count as income.
        excluded: row.excluded && !["income", "transfer", "credit_card_payment"].includes(type),
        notes: row.notes || null,
        recurring_item_id: row.recurring ? (recurringId.get(row.recurring.toLowerCase()) ?? null) : null,
        external_transaction_id: row.externalId || null,
        import_id: importId,
        import_hash: r.hash,
      };
    });
    if (inserts.some((t) => !t.account_id)) throw Object.assign(new Error("Some rows have no account mapping"), { code: "22023" });

    const batches = chunk(inserts, 500);
    for (let i = 0; i < batches.length; i++) {
      onProgress("Importing transactions", i * 500, inserts.length);
      await must(sb.from("transactions").insert(batches[i]));
    }
    onProgress("Importing transactions", inserts.length, inserts.length);

    for (const b of chunk(tagLinks, 1000)) await must(sb.from("transaction_tags").insert(b));

    // ---- Import history (one row per CSV line) -----------------------------
    const history: TablesInsert<"import_rows">[] = plan.rows.map((r) => ({
      import_id: importId,
      row_number: r.row.rowNumber,
      raw: r.row.raw as unknown as Json,
      status: r.row.errors.length ? "error" : r.decision === "import" ? "imported" : r.dup !== "none" ? "duplicate" : "skipped",
      transaction_id: rowTxn.get(r.row.rowNumber) ?? null,
      message: r.row.errors.length
        ? r.row.errors.join("; ").slice(0, 500)
        : r.dup === "exact"
          ? "Already imported"
          : r.dup === "possible"
            ? "Possible duplicate"
            : null,
    }));
    const hb = chunk(history, 1000);
    for (let i = 0; i < hb.length; i++) {
      onProgress("Saving import history", i * 1000, history.length);
      await must(sb.from("import_rows").insert(hb[i]));
    }

    // ---- Categorization rules ---------------------------------------------
    let rulesApplied = 0;
    for (const ids of chunk(txIds, 2000)) {
      onProgress("Applying rules", 0, 1);
      rulesApplied += await must(sb.rpc("apply_categorization_rules", { p_transaction_ids: ids, p_only_unreviewed: true, p_import_only: true }));
    }

    // ---- Recurring items: link new rows that match an item's phrases -------
    let recurringLinked = 0;
    for (const ids of chunk(txIds, 2000)) {
      onProgress("Linking recurring items", 0, 1);
      recurringLinked += await must(sb.rpc("auto_link_recurring", { p_transaction_ids: ids }));
    }

    await must(
      sb
        .from("imports")
        .update({
          status: "completed",
          imported_count: inserts.length,
          duplicate_count: dupSkipped,
          skipped_count: otherSkipped,
          error_count: errorCount,
          completed_at: new Date().toISOString(),
        })
        .eq("id", importId),
    );

    return {
      importId,
      imported: inserts.length,
      duplicates: dupSkipped,
      skipped: otherSkipped,
      errors: errorCount,
      accountsCreated: newAccounts.length,
      categoriesCreated,
      recurringCreated,
      rulesApplied,
      recurringLinked,
    };
  } catch (err) {
    await sb.from("imports").update({ status: "failed", error_count: errorCount, completed_at: new Date().toISOString() }).eq("id", importId);
    throw err;
  }
}
