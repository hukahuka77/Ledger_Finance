/**
 * CSV import — pure, UI-free logic (parsing, column detection, normalisation,
 * fingerprinting). Everything here treats CSV content strictly as data.
 */
import { parseMoney } from "@/lib/money";
import type { AccountType, TransactionType } from "@/lib/domain";

export const APP_FIELDS = {
  date: { label: "Transaction date", required: true },
  merchant: { label: "Merchant / name", required: true },
  description: { label: "Original description", required: false },
  amount: { label: "Amount", required: false },
  outflow: { label: "Outflow (debit)", required: false },
  inflow: { label: "Inflow (credit)", required: false },
  account: { label: "Account", required: false },
  account_mask: { label: "Account last 4", required: false },
  category: { label: "Category", required: false },
  parent_category: { label: "Parent category", required: false },
  type: { label: "Transaction type", required: false },
  status: { label: "Pending / posted", required: false },
  excluded: { label: "Excluded", required: false },
  notes: { label: "Notes", required: false },
  tags: { label: "Tags", required: false },
  recurring: { label: "Recurring name", required: false },
  external_id: { label: "External transaction ID", required: false },
} as const;
export type AppField = keyof typeof APP_FIELDS;
export type ColumnMapping = Partial<Record<AppField, string>>;

const HEADER_HINTS: Record<AppField, RegExp> = {
  date: /^(transaction[ _]?)?date$|^posted[ _]?date$|^date[ _]?posted$|^trans\.? date$/i,
  merchant: /^(name|merchant|payee|merchant[ _]name|description|memo)$/i,
  description: /^(original[ _]?description|original[ _]?name|raw[ _]?description|bank[ _]?description|full[ _]?description)$/i,
  amount: /^(amount|transaction[ _]?amount|value)$/i,
  outflow: /^(debit|outflow|withdrawal|withdrawals|money out|spent)$/i,
  inflow: /^(credit|inflow|deposit|deposits|money in|received)$/i,
  account: /^(account|account[ _]?name)$/i,
  account_mask: /^(account[ _]?mask|mask|last[ _]?(4|four)|account[ _]?number)$/i,
  category: /^(category|subcategory|sub[ _]category)$/i,
  parent_category: /^(parent[ _]?category|category[ _]?group|group)$/i,
  type: /^(type|transaction[ _]?type)$/i,
  status: /^(status|pending)$/i,
  excluded: /^(excluded|exclude|hidden|ignore)$/i,
  notes: /^(note|notes|memo[ _]?notes)$/i,
  tags: /^(tags?|labels?)$/i,
  recurring: /^(recurring|recurring[ _]?name|subscription)$/i,
  external_id: /^(id|transaction[ _]?id|external[ _]?id|reference|ref)$/i,
};

export function detectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  (Object.keys(HEADER_HINTS) as AppField[]).forEach((field) => {
    const hit = headers.find((h) => !used.has(h) && HEADER_HINTS[field].test(h.trim()));
    if (hit) {
      mapping[field] = hit;
      used.add(hit);
    }
  });
  // "description" doubles as merchant when there's no name column.
  if (!mapping.merchant && mapping.description) {
    mapping.merchant = mapping.description;
  }
  return mapping;
}

/** Strip control characters, normalise whitespace (incl. NBSP), cap length. */
export function clean(v: unknown, max = 500): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export type DateFormat = "auto" | "ymd" | "mdy" | "dmy";

const pad = (n: number) => String(n).padStart(2, "0");
function validYMD(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseDate(raw: string, format: DateFormat = "auto"): string | null {
  const s = clean(raw, 40);
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);
  if (m) return validYMD(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ,].*)?$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    if (format === "dmy" || (format === "auto" && a > 12)) return validYMD(y, b, a);
    return validYMD(y, a, b);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return validYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

export function parseBool(raw: string): boolean {
  return /^(true|yes|y|1|x|excluded|hidden)$/i.test(clean(raw, 20));
}

export function parseTags(raw: string): string[] {
  return [
    ...new Set(
      clean(raw, 1000)
        .split(/[,;|]/)
        .map((t) => t.trim().replace(/^#/, "").slice(0, 50))
        .filter(Boolean),
    ),
  ];
}

export function guessAccountType(name: string): AccountType {
  const n = name.toLowerCase();
  if (/mortgage/.test(n)) return "mortgage";
  if (/loan|lending/.test(n)) return "loan";
  if (/401k|403b|\bira\b|roth|retire|pension/.test(n)) return "retirement";
  if (/brokerage|invest|fidelity|schwab|vanguard|etrade|e\*trade/.test(n)) return "brokerage";
  if (/saving|hysa|money market/.test(n)) return "savings";
  if (/checking|chequing|debit/.test(n)) return "checking";
  if (/card|visa|mastercard|master card|amex|american express|discover|credit/.test(n)) return "credit_card";
  if (/venmo|cash app|paypal|apple cash|\bcash\b|wallet/.test(n)) return "cash";
  return "checking";
}

export interface ImportOptions {
  /** How the CSV signs amounts. */
  signConvention: "negative_is_outflow" | "positive_is_outflow";
  dateFormat: DateFormat;
  /** Used when there is no account column. */
  defaultAccountLabel: string;
  /** Mark rows dated before this ISO date as reviewed (historical data). */
  reviewedBefore: string;
}

export interface NormalizedRow {
  rowNumber: number;
  raw: Record<string, string>;
  errors: string[];
  date: string;
  merchant: string;
  description: string;
  /** Signed: negative = money out. */
  amount: number;
  accountKey: string;
  accountName: string;
  accountMask: string;
  categoryKey: string;
  categoryName: string;
  parentName: string;
  rawType: string;
  status: "pending" | "posted";
  excluded: boolean;
  notes: string;
  tags: string[];
  recurring: string;
  externalId: string;
}

export const accountKeyOf = (name: string, mask: string) => `${name.toLowerCase()}|${mask.toLowerCase()}`;
export const categoryKeyOf = (parent: string, name: string) => `${parent.toLowerCase()}|${name.toLowerCase()}`;

export function normalizeRows(records: Record<string, string>[], mapping: ColumnMapping, opts: ImportOptions): NormalizedRow[] {
  const get = (r: Record<string, string>, f: AppField, max = 500) => (mapping[f] ? clean(r[mapping[f]!], max) : "");
  return records.map((r, i) => {
    const errors: string[] = [];
    const date = parseDate(get(r, "date", 40), opts.dateFormat);
    if (!date) errors.push("Invalid or missing date");

    let amount: number | null = null;
    if (mapping.amount) {
      const v = parseMoney(get(r, "amount", 40));
      if (v !== null) amount = opts.signConvention === "positive_is_outflow" ? -v : v;
    } else if (mapping.outflow || mapping.inflow) {
      const out = parseMoney(get(r, "outflow", 40)) ?? 0;
      const inn = parseMoney(get(r, "inflow", 40)) ?? 0;
      if (get(r, "outflow", 40) || get(r, "inflow", 40)) amount = Math.round((Math.abs(inn) - Math.abs(out)) * 100) / 100;
    }
    if (amount === null) errors.push("Invalid or missing amount");

    const description = get(r, "description", 500);
    const merchant = get(r, "merchant", 200) || description.slice(0, 200);
    if (!merchant) errors.push("Missing merchant / name");

    const accountName = get(r, "account", 120) || opts.defaultAccountLabel || "Imported account";
    const accountMask = get(r, "account_mask", 8)
      .replace(/[^0-9A-Za-z]/g, "")
      .slice(-4);
    const categoryName = get(r, "category", 80);
    const parentName = get(r, "parent_category", 80);
    const statusRaw = get(r, "status", 20).toLowerCase();

    return {
      rowNumber: i + 1,
      raw: Object.fromEntries(Object.entries(r).map(([k, v]) => [clean(k, 100), clean(v, 1000)])),
      errors,
      date: date ?? "",
      merchant,
      description: description || merchant,
      amount: amount ?? 0,
      accountKey: accountKeyOf(accountName, accountMask),
      accountName,
      accountMask,
      categoryKey: categoryName ? categoryKeyOf(parentName, categoryName) : "",
      categoryName,
      parentName,
      rawType: get(r, "type", 40),
      status: statusRaw === "pending" || statusRaw === "true" ? "pending" : "posted",
      excluded: mapping.excluded ? parseBool(get(r, "excluded", 20)) : false,
      notes: get(r, "notes", 5000),
      tags: mapping.tags ? parseTags(get(r, "tags", 1000)) : [],
      recurring: get(r, "recurring", 120),
      externalId: get(r, "external_id", 200),
    };
  });
}

/** Guess the sign convention: most exports where "regular" spending is positive are positive-is-outflow. */
export function guessSignConvention(records: Record<string, string>[], mapping: ColumnMapping): ImportOptions["signConvention"] {
  if (!mapping.amount) return "negative_is_outflow";
  let pos = 0;
  let neg = 0;
  let incomeNeg = 0;
  let incomePos = 0;
  for (const r of records.slice(0, 2000)) {
    const v = parseMoney(clean(r[mapping.amount], 40));
    if (v === null || v === 0) continue;
    if (v > 0) pos++;
    else neg++;
    if (mapping.type && /income/i.test(clean(r[mapping.type], 40))) {
      if (v < 0) incomeNeg++;
      else incomePos++;
    }
  }
  if (incomeNeg + incomePos > 0) return incomeNeg > incomePos ? "positive_is_outflow" : "negative_is_outflow";
  return pos > neg * 2 ? "positive_is_outflow" : "negative_is_outflow";
}

/** Map a CSV "type" value plus context onto our transaction types. */
export function resolveType(row: NormalizedRow, accountType: AccountType | undefined, hasTypeColumn: boolean, categoryType?: string): TransactionType {
  const t = row.rawType.toLowerCase().replace(/[-\s]+/g, "_");
  const inflow = row.amount > 0;
  const known: TransactionType[] = ["expense", "income", "transfer", "credit_card_payment", "refund", "adjustment"];
  if (known.includes(t as TransactionType)) return t as TransactionType;
  // Transfer and owner's-equity accounts move money without being income or spending.
  if (categoryType === "transfer" || categoryType === "equity") return accountType === "credit_card" && inflow ? "credit_card_payment" : "transfer";
  if (t.includes("income") || t.includes("deposit") || t.includes("payroll")) return "income";
  if (t.includes("transfer")) return accountType === "credit_card" && inflow ? "credit_card_payment" : "transfer";
  if (t.includes("payment") && accountType === "credit_card") return "credit_card_payment";
  if (t.includes("refund") || t.includes("return")) return "refund";
  if (t.includes("adjust")) return "adjustment";
  if (!inflow) return "expense";
  // Money in on a "regular" row nets against spending (refunds, reimbursements).
  if (hasTypeColumn) return "refund";
  return categoryType === "expense" || categoryType === "cost_of_goods" ? "refund" : "income";
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministic fingerprint. Includes the occurrence index of identical rows in
 * the file so genuine same-day repeats (two $4.65 Ubers) survive, while
 * re-importing the same file is detected.
 */
export async function fingerprintRows(rows: NormalizedRow[]): Promise<string[]> {
  const seen = new Map<string, number>();
  return Promise.all(
    rows.map((r) => {
      const base = [r.accountKey, r.date, Math.round(r.amount * 100), r.merchant.toLowerCase(), r.externalId.toLowerCase()].join("|");
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return sha256(`${base}|${n}`);
    }),
  );
}

/** Median gap in days between sorted ISO dates → closest frequency. */
export function inferFrequency(dates: string[]): { frequency: string; interval: number } {
  const ds = [...new Set(dates)].sort();
  if (ds.length < 2) return { frequency: "monthly", interval: 1 };
  const gaps: number[] = [];
  for (let i = 1; i < ds.length; i++) gaps.push((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 86_400_000);
  gaps.sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length / 2)];
  if (g <= 9) return { frequency: "weekly", interval: 1 };
  if (g <= 18) return { frequency: "biweekly", interval: 1 };
  if (g <= 45) return { frequency: "monthly", interval: 1 };
  if (g <= 120) return { frequency: "quarterly", interval: 1 };
  if (g <= 240) return { frequency: "semiannual", interval: 1 };
  if (g <= 450) return { frequency: "annual", interval: 1 };
  return { frequency: "custom", interval: Math.round(g) };
}
