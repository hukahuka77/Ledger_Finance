/**
 * Detect likely recurring charges/deposits in recent history (pure, testable).
 * A group qualifies when the same merchant repeats on a regular cadence with a
 * consistent amount, is still active, and isn't already tracked.
 */
import { addDays, differenceInCalendarDays } from "date-fns";
import { fromISODate, stepDate, toISODate } from "@/lib/dates";
import type { Frequency, RecurringType } from "@/lib/domain";

export interface DetectInputTxn {
  id: string;
  transaction_date: string;
  amount: number;
  merchant_name: string;
  account_id: string;
  category_id: string | null;
  transaction_type: string;
  recurring_item_id: string | null;
}

export interface RecurringSuggestion {
  key: string;
  name: string;
  merchantPattern: string;
  accountId: string | null;
  categoryId: string | null;
  frequency: Frequency;
  amount: number;
  amountType: "fixed" | "estimated" | "variable";
  recurringType: RecurringType;
  nextDate: string;
  lastDate: string;
  occurrences: number;
  transactionIds: string[];
}

const CADENCES: { frequency: Frequency; days: number; tolerance: number; minCount: number }[] = [
  { frequency: "weekly", days: 7, tolerance: 1.5, minCount: 5 },
  { frequency: "biweekly", days: 14, tolerance: 2.5, minCount: 4 },
  { frequency: "monthly", days: 30.4, tolerance: 5, minCount: 3 },
  { frequency: "quarterly", days: 91, tolerance: 12, minCount: 3 },
  { frequency: "semiannual", days: 182, tolerance: 20, minCount: 2 },
  { frequency: "annual", days: 365, tolerance: 20, minCount: 2 },
];

const SUBSCRIPTION_HINT =
  /netflix|spotify|hulu|disney|hbo|max\b|youtube|apple|icloud|google|github|adobe|openai|chatgpt|anthropic|claude|todoist|notion|dropbox|microsoft|amazon prime|audible|patreon|substack|nyt|peacock|paramount|crunchyroll|duolingo|1password|canva|vercel/i;

/** Merchant key that survives store numbers, reference codes and amounts embedded in bank descriptions. */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/#\s*\w+/g, " ")
    .replace(/\b\d[\d\-./]*\b/g, " ")
    .replace(/[*_]+/g, " ")
    .replace(/\b(ref|id|ppd|web|ach|pos|debit|purchase|payment|recurring|online|mobile)\b/g, " ")
    .replace(/[^a-z& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mode<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  xs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Longest common, word-aligned prefix of the raw names, so linking by "contains" catches every variant. */
function commonPattern(names: string[]): string {
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i].toLowerCase() === n[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s*#\-.]+\S*$/, (m) => (/\s/.test(m) ? "" : m)).trim();
  return prefix.length >= 3 ? prefix : mode(names);
}

export function detectRecurring(
  txns: DetectInputTxn[],
  opts: { today: string; existingPatterns: string[]; categoryNameById?: Map<string, string>; dismissed?: Set<string> },
): RecurringSuggestion[] {
  const today = fromISODate(opts.today);
  // Compare on normalized names so stored patterns containing dates/ids still recognise their merchant.
  const patterns = opts.existingPatterns.map((p) => normalizeMerchant(p)).filter((p) => p.length >= 3);
  const groups = new Map<string, DetectInputTxn[]>();

  for (const t of txns) {
    if (t.recurring_item_id || t.transaction_type === "credit_card_payment" || t.transaction_type === "adjustment" || t.amount === 0) continue;
    const norm = normalizeMerchant(t.merchant_name);
    if (norm.length < 3) continue;
    const key = `${norm}|${t.amount > 0 ? "in" : "out"}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const out: RecurringSuggestion[] = [];
  for (const [key, list] of groups) {
    if (opts.dismissed?.has(key)) continue;
    const norm = key.slice(0, key.lastIndexOf("|"));
    if (patterns.some((p) => norm.includes(p) || p.includes(norm))) continue;

    // One charge per day at most; keep the latest few hundred days.
    const byDay = new Map<string, DetectInputTxn>();
    [...list].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date)).forEach((t) => byDay.set(t.transaction_date, t));
    const series = [...byDay.values()];
    if (series.length < 2) continue;

    const gaps: number[] = [];
    for (let i = 1; i < series.length; i++)
      gaps.push(differenceInCalendarDays(fromISODate(series[i].transaction_date), fromISODate(series[i - 1].transaction_date)));
    const g = median(gaps);
    const cadence = CADENCES.find((c) => Math.abs(g - c.days) <= c.tolerance);
    if (!cadence || series.length < cadence.minCount) continue;
    const regular = gaps.filter((x) => Math.abs(x - cadence.days) <= cadence.tolerance * 1.6).length / gaps.length;
    if (regular < 0.75) continue;

    const last = series[series.length - 1];
    // Still active: last seen within ~1.6 cycles.
    if (differenceInCalendarDays(today, fromISODate(last.transaction_date)) > cadence.days * 1.6) continue;

    const recent = series.slice(-6).map((t) => Math.abs(t.amount));
    const mean = recent.reduce((s, x) => s + x, 0) / recent.length;
    const cv = mean ? Math.sqrt(recent.reduce((s, x) => s + (x - mean) ** 2, 0) / recent.length) / mean : 1;
    const inflow = last.amount > 0;
    const isTransfer = last.transaction_type === "transfer";
    // Frequent, variable spending (coffee, groceries) isn't a bill.
    const maxCv = inflow || isTransfer ? 0.35 : cadence.days < 20 ? 0.12 : 0.45;
    if (cv > maxCv) continue;
    const fixed = recent.every((x) => Math.round(x * 100) === Math.round(recent[0] * 100));
    // Rare cadences need strong evidence: a fixed outgoing amount.
    if (cadence.days > 120 && (inflow || !fixed)) continue;
    // Transfers of varying size (card payoffs, ad-hoc savings) are not schedules.
    if (isTransfer && cv > 0.15) continue;
    const amountType = recent.every((x) => Math.round(x * 100) === Math.round(recent[0] * 100)) ? "fixed" : cv <= 0.15 ? "estimated" : "variable";

    const categoryId = mode(series.map((t) => t.category_id));
    const categoryName = (categoryId && opts.categoryNameById?.get(categoryId)) || "";
    const name = mode(series.map((t) => t.merchant_name));
    const recurringType: RecurringType = inflow
      ? "income"
      : isTransfer
        ? "transfer"
        : /loan/i.test(categoryName) || /\bloan\b|mortgage/i.test(name)
          ? "loan"
          : /subscri|stream|software/i.test(categoryName) || SUBSCRIPTION_HINT.test(name)
            ? "subscription"
            : "bill";

    let next = stepDate(fromISODate(last.transaction_date), cadence.frequency);
    let guard = 0;
    while (next < addDays(today, -3) && guard++ < 60) next = stepDate(next, cadence.frequency);

    out.push({
      key,
      name,
      merchantPattern: commonPattern(series.map((t) => t.merchant_name)),
      accountId: mode(series.map((t) => t.account_id)),
      categoryId,
      frequency: cadence.frequency,
      amount: Math.round(median(series.slice(-3).map((t) => Math.abs(t.amount))) * 100) / 100,
      amountType,
      recurringType,
      nextDate: toISODate(next),
      lastDate: last.transaction_date,
      occurrences: series.length,
      transactionIds: list.map((t) => t.id),
    });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || a.nextDate.localeCompare(b.nextDate));
}
