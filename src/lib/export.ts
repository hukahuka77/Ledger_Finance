import Papa from "papaparse";
import type { Account, LedgerTransaction, Tag } from "@/lib/domain";
import type { TransactionFilters } from "@/lib/filters";
import { buildListQuery, PAGE_SIZE } from "@/lib/queries/transactions";
import type { CategoryIndex } from "@/lib/queries/reference";

const MAX_ROWS = 60_000;

/** Neutralise spreadsheet formula injection in exported text cells. */
export function safeCell(v: string) {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Download every transaction matching the current filters as CSV. */
export async function exportTransactions(
  filters: TransactionFilters,
  cats: CategoryIndex,
  accounts: Map<string, Account>,
  tags: Map<string, Tag>,
  onProgress?: (n: number) => void,
): Promise<number> {
  const rows: LedgerTransaction[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await buildListQuery(filters, cats, offset, false);
    if (error) throw error;
    const page = (data ?? []) as unknown as LedgerTransaction[];
    rows.push(...page);
    onProgress?.(rows.length);
    if (page.length < PAGE_SIZE) break;
  }

  const csv = Papa.unparse(
    rows.map((t) => {
      const cat = t.category_id ? cats.byId.get(t.category_id) : undefined;
      const parent = cats.parentOf(t.category_id);
      const acct = accounts.get(t.account_id);
      return {
        date: t.transaction_date,
        merchant: safeCell(t.merchant_name),
        original_description: safeCell(t.original_description ?? ""),
        amount: t.amount.toFixed(2),
        type: t.transaction_type,
        category: safeCell(cat?.name ?? ""),
        parent_category: safeCell(parent?.name ?? ""),
        account: safeCell(acct?.name ?? ""),
        account_mask: acct?.last_four ?? "",
        status: t.status,
        review_status: t.review_status,
        excluded: t.excluded,
        tags: safeCell(
          t.transaction_tags
            .map((x) => tags.get(x.tag_id)?.name)
            .filter(Boolean)
            .join(", "),
        ),
        notes: safeCell(t.notes ?? ""),
      };
    }),
  );

  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `transactions-${new Date().toISOString().slice(0, 10)}.csv`);
  return rows.length;
}

/** Save a file in the browser. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Save rows as a CSV file. Text cells are guarded against spreadsheet formula injection. */
export function downloadCsv(filename: string, rows: Record<string, string | number | null | undefined>[]) {
  const safe = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? safeCell(v) : (v ?? "")])));
  downloadBlob(new Blob([Papa.unparse(safe)], { type: "text/csv;charset=utf-8" }), filename);
}
