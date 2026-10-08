/**
 * Reports: everything the Reports page shows, computed from countable ledger entries
 * (the same lines the rest of the app counts: transfers, card payments and excluded
 * transactions are already gone, and split transactions arrive as one line per split).
 *
 * Spending is expenses net of refunds, by category. Income is income-type lines.
 */
import { addMonths, endOfMonth, endOfYear, format, getDay, startOfMonth, startOfYear, subMonths, subYears } from "date-fns";
import type { Category } from "@/lib/domain";
import { fromISODate, toISODate } from "@/lib/dates";

export interface ReportEntry {
  transaction_id: string;
  account_id: string | null;
  transaction_date: string;
  merchant_name: string | null;
  amount: number;
  category_id: string | null;
  transaction_type: string;
}

export const UNCATEGORIZED = "__none";

export type ReportPeriod = "this_month" | "last_month" | "last_3_months" | "last_6_months" | "last_12_months" | "this_year" | "last_year" | "custom";
export const REPORT_PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_3_months", label: "Last 3 months" },
  { value: "last_6_months", label: "Last 6 months" },
  { value: "last_12_months", label: "Last 12 months" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom range" },
];

/** Date range for a period. "Last N months" are whole months ending with the current one. */
export function reportRange(period: ReportPeriod, custom: { from?: string; to?: string } = {}, now = new Date()): { from: string; to: string } {
  const months = (n: number) => ({ from: toISODate(startOfMonth(subMonths(now, n - 1))), to: toISODate(endOfMonth(now)) });
  switch (period) {
    case "last_month": {
      const m = subMonths(now, 1);
      return { from: toISODate(startOfMonth(m)), to: toISODate(endOfMonth(m)) };
    }
    case "last_3_months":
      return months(3);
    case "last_6_months":
      return months(6);
    case "last_12_months":
      return months(12);
    case "this_year":
      return { from: toISODate(startOfYear(now)), to: toISODate(endOfYear(now)) };
    case "last_year": {
      const y = subYears(now, 1);
      return { from: toISODate(startOfYear(y)), to: toISODate(endOfYear(y)) };
    }
    case "custom": {
      const from = custom.from || toISODate(startOfMonth(now));
      const to = custom.to && custom.to >= from ? custom.to : toISODate(endOfMonth(fromISODate(from)));
      return { from, to };
    }
    default:
      return { from: toISODate(startOfMonth(now)), to: toISODate(endOfMonth(now)) };
  }
}

// Validated categorical palette (dataviz validator, light surface): spending areas take
// slots in their category order, so an area keeps its color whatever the filters show.
export const AREA_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
/** Areas past the eighth, and uncategorized spending. */
export const OTHER_COLOR = "#9a958d";
/** Income and money left over (matches the app's income series). */
export const INCOME_COLOR = "#4271B0";

export interface AreaColorer {
  (groupId: string): string;
}

/** Fixed color per top-level spending category, by category order (not by size). */
export function areaColors(parents: Category[]): AreaColorer {
  const order = parents.filter((p) => !["income", "transfer", "equity"].includes(p.category_type)).map((p) => p.id);
  return (id) => {
    const i = order.indexOf(id);
    return i >= 0 && i < AREA_PALETTE.length ? AREA_PALETTE[i] : OTHER_COLOR;
  };
}

export interface ReportFilters {
  accountIds: string[];
  /** Selected categories; a top-level category includes its subcategories. UNCATEGORIZED for none. */
  categoryIds: string[];
  /** Merchant or description text. */
  search: string;
}

export interface Leaf {
  id: string;
  name: string;
  amount: number;
  count: number;
}
export interface Area extends Leaf {
  color: string;
  children: Leaf[];
}

export interface Report {
  from: string;
  to: string;
  months: number;
  income: number;
  spending: number;
  net: number;
  /** Share of income left over, or null with no income. */
  savingsRate: number | null;
  transactionCount: number;
  /** Spending areas (top-level categories) with their categories, largest first. Net of refunds, never below zero. */
  areas: Area[];
  incomeSources: Leaf[];
  monthly: { month: string; income: number; spending: number }[];
  /** Spending per month per area id. */
  monthlyByArea: Record<string, number | string>[];
  merchants: { name: string; amount: number; count: number }[];
  weekdays: { day: string; amount: number; count: number }[];
  accounts: { id: string; name: string; amount: number; count: number }[];
  largest: ReportEntry[];
}

type CategoryLookup = { byId: Map<string, Category>; expand: (id: string) => string[] };

export function filterEntries(entries: ReportEntry[], f: ReportFilters, cats: CategoryLookup): ReportEntry[] {
  const accounts = f.accountIds.length ? new Set(f.accountIds) : null;
  const categories = f.categoryIds.length ? new Set(f.categoryIds.flatMap((id) => (id === UNCATEGORIZED ? [id] : cats.expand(id)))) : null;
  const q = f.search.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!accounts || (e.account_id && accounts.has(e.account_id))) &&
      (!categories || categories.has(e.category_id ?? UNCATEGORIZED)) &&
      (!q || (e.merchant_name ?? "").toLowerCase().includes(q)),
  );
}

const cents = (n: number) => Math.round(n * 100) / 100;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = startOfMonth(fromISODate(from)); m <= fromISODate(to); m = addMonths(m, 1)) out.push(toISODate(m));
  return out;
}

export function buildReport(
  entries: ReportEntry[],
  range: { from: string; to: string },
  cats: CategoryLookup,
  colorOf: AreaColorer,
  accountName: (id: string) => string,
): Report {
  const monthKeys = monthsBetween(range.from, range.to);
  const monthly = new Map(monthKeys.map((m) => [m, { month: m, income: 0, spending: 0 }]));
  const byArea = new Map<string, Map<string, number>>(); // month -> area -> spend
  const leafSpend = new Map<string, { amount: number; count: number }>();
  const incomeBy = new Map<string, { amount: number; count: number }>();
  const merchants = new Map<string, { name: string; amount: number; count: number }>();
  const weekdays = WEEKDAYS.map((day) => ({ day, amount: 0, count: 0 }));
  const accounts = new Map<string, { amount: number; count: number }>();
  const txns = new Set<string>();
  let income = 0;
  let spending = 0;

  const areaOf = (categoryId: string | null) => {
    const c = categoryId ? cats.byId.get(categoryId) : undefined;
    if (!c) return UNCATEGORIZED;
    return c.parent_category_id && cats.byId.has(c.parent_category_id) ? c.parent_category_id : c.id;
  };
  const bump = <K>(m: Map<K, { amount: number; count: number }>, k: K, amount: number) => {
    const v = m.get(k) ?? { amount: 0, count: 0 };
    v.amount += amount;
    v.count += 1;
    m.set(k, v);
  };

  for (const e of entries) {
    txns.add(e.transaction_id);
    const month = monthly.get(e.transaction_date.slice(0, 8) + "01");
    if (e.transaction_type === "income") {
      income += e.amount;
      if (month) month.income += e.amount;
      bump(incomeBy, e.category_id ?? UNCATEGORIZED, e.amount);
      continue;
    }
    // expense (negative) or refund (positive): spend is the negation.
    const spend = -e.amount;
    spending += spend;
    if (month) month.spending += spend;
    bump(leafSpend, e.category_id ?? UNCATEGORIZED, spend);
    const area = areaOf(e.category_id);
    const mk = e.transaction_date.slice(0, 8) + "01";
    const am = byArea.get(mk) ?? new Map<string, number>();
    am.set(area, (am.get(area) ?? 0) + spend);
    byArea.set(mk, am);
    if (e.account_id) bump(accounts, e.account_id, spend);
    const name = (e.merchant_name ?? "").trim() || "Unknown";
    const key = name.toLowerCase();
    const m = merchants.get(key) ?? { name, amount: 0, count: 0 };
    m.amount += spend;
    m.count += 1;
    merchants.set(key, m);
    if (e.transaction_type === "expense") {
      const w = weekdays[(getDay(fromISODate(e.transaction_date)) + 6) % 7];
      w.amount += spend;
      w.count += 1;
    }
  }

  // Areas with their categories. A category whose refunds outweigh its spending shows as zero.
  const areas = new Map<string, Area>();
  for (const [catId, v] of leafSpend) {
    const areaId = areaOf(catId === UNCATEGORIZED ? null : catId);
    const area =
      areas.get(areaId) ??
      ({
        id: areaId,
        name: areaId === UNCATEGORIZED ? "Uncategorized" : (cats.byId.get(areaId)?.name ?? "Unknown"),
        amount: 0,
        count: 0,
        color: areaId === UNCATEGORIZED ? OTHER_COLOR : colorOf(areaId),
        children: [],
      } satisfies Area);
    areas.set(areaId, area);
    const amount = cents(Math.max(0, v.amount));
    area.count += v.count;
    if (amount <= 0) continue;
    area.children.push({
      id: catId,
      name: catId === UNCATEGORIZED ? "Uncategorized" : catId === areaId ? `${area.name} (general)` : (cats.byId.get(catId)?.name ?? "Unknown"),
      amount,
      count: v.count,
    });
  }
  const areaList = [...areas.values()]
    .map((a) => {
      a.children.sort((x, y) => y.amount - x.amount);
      a.amount = cents(a.children.reduce((s, c) => s + c.amount, 0));
      // An area with a single "(general)" line reads better under its own name.
      if (a.children.length === 1 && a.children[0].id === a.id) a.children[0].name = a.name;
      return a;
    })
    .filter((a) => a.amount > 0)
    .sort((x, y) => y.amount - x.amount);

  const incomeSources = [...incomeBy.entries()]
    .map(([id, v]) => ({
      id,
      name: id === UNCATEGORIZED ? "Other income" : (cats.byId.get(id)?.name ?? "Other income"),
      amount: cents(v.amount),
      count: v.count,
    }))
    .filter((s) => s.amount > 0)
    .sort((x, y) => y.amount - x.amount);

  income = cents(income);
  spending = cents(spending);
  return {
    from: range.from,
    to: range.to,
    months: monthKeys.length,
    income,
    spending,
    net: cents(income - spending),
    savingsRate: income > 0 ? (income - spending) / income : null,
    transactionCount: txns.size,
    areas: areaList,
    incomeSources,
    monthly: [...monthly.values()].map((m) => ({ ...m, income: cents(m.income), spending: cents(m.spending) })),
    monthlyByArea: monthKeys.map((m) => {
      const row: Record<string, number | string> = { month: m };
      for (const a of areaList) row[a.id] = cents(Math.max(0, byArea.get(m)?.get(a.id) ?? 0));
      return row;
    }),
    merchants: [...merchants.values()]
      .filter((m) => m.amount > 0)
      .map((m) => ({ ...m, amount: cents(m.amount) }))
      .sort((x, y) => y.amount - x.amount),
    weekdays: weekdays.map((w) => ({ ...w, amount: cents(w.amount) })),
    accounts: [...accounts.entries()]
      .map(([id, v]) => ({ id, name: accountName(id), amount: cents(v.amount), count: v.count }))
      .filter((a) => a.amount > 0)
      .sort((x, y) => y.amount - x.amount),
    largest: entries
      .filter((e) => e.transaction_type === "expense")
      .sort((x, y) => x.amount - y.amount)
      .slice(0, 10),
  };
}

export function monthLabel(month: string, long = false): string {
  return format(fromISODate(month), long ? "MMMM yyyy" : "MMM");
}

// ---------------------------------------------------------------------------
// Sankey: income sources → Income → areas → categories
// ---------------------------------------------------------------------------
export type SankeyMode = "areas" | "categories" | "both";
export interface SankeyNode {
  id: string;
  name: string;
  value: number;
  color: string;
  column: number;
}
export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  color: string;
}

/**
 * Nodes and links for the money-flow chart. Left over income flows to "Saved"; spending
 * beyond income flows in from "From savings". Categories under `minShare` of the total
 * fold into one "other" line per area so every label has room.
 */
export function buildSankey(r: Report, mode: SankeyMode, minShare = 0.012): { nodes: SankeyNode[]; links: SankeyLink[]; total: number } {
  const nodes: SankeyNode[] = [];
  const links: SankeyLink[] = [];
  const saved = cents(r.income - r.spending);
  const total = Math.max(r.income, r.spending);
  if (total <= 0) return { nodes, links, total: 0 };

  const sources = r.incomeSources.map((s) => ({ ...s }));
  if (saved < 0) sources.push({ id: "__from_savings", name: "From savings", amount: -saved, count: 0 });
  for (const s of sources) {
    nodes.push({ id: `in:${s.id}`, name: s.name, value: s.amount, color: s.id === "__from_savings" ? OTHER_COLOR : INCOME_COLOR, column: 0 });
    links.push({ source: `in:${s.id}`, target: "hub", value: s.amount, color: s.id === "__from_savings" ? OTHER_COLOR : INCOME_COLOR });
  }
  const hubValue = cents(sources.reduce((s, x) => s + x.amount, 0));
  nodes.push({ id: "hub", name: r.income > 0 ? "Income" : "Spending", value: hubValue, color: INCOME_COLOR, column: 1 });

  const leaves = (a: Area) => {
    const keep = a.children.filter((c) => c.amount >= total * minShare);
    const rest = a.children.filter((c) => c.amount < total * minShare);
    const restSum = cents(rest.reduce((s, c) => s + c.amount, 0));
    if (rest.length === 1) keep.push(rest[0]);
    else if (restSum > 0) keep.push({ id: `${a.id}:rest`, name: keep.length ? `Other ${a.name}` : a.name, amount: restSum, count: 0 });
    return keep;
  };

  for (const a of r.areas) {
    if (mode === "categories") {
      for (const c of leaves(a)) {
        nodes.push({ id: `cat:${a.id}:${c.id}`, name: c.name, value: c.amount, color: a.color, column: 2 });
        links.push({ source: "hub", target: `cat:${a.id}:${c.id}`, value: c.amount, color: a.color });
      }
      continue;
    }
    nodes.push({ id: `area:${a.id}`, name: a.name, value: a.amount, color: a.color, column: 2 });
    links.push({ source: "hub", target: `area:${a.id}`, value: a.amount, color: a.color });
    if (mode === "both") {
      const kids = leaves(a);
      // An area that is one category needs no second column.
      if (kids.length === 1 && (kids[0].id === a.id || kids[0].name === a.name)) continue;
      for (const c of kids) {
        nodes.push({ id: `cat:${a.id}:${c.id}`, name: c.name, value: c.amount, color: a.color, column: 3 });
        links.push({ source: `area:${a.id}`, target: `cat:${a.id}:${c.id}`, value: c.amount, color: a.color });
      }
    }
  }
  if (saved > 0) {
    nodes.push({ id: "saved", name: "Saved", value: saved, color: INCOME_COLOR, column: 2 });
    links.push({ source: "hub", target: "saved", value: saved, color: INCOME_COLOR });
  }
  return { nodes, links, total: hubValue };
}
