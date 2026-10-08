import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/domain";
import { buildCategoryIndex } from "@/lib/queries/reference";
import { AREA_PALETTE, areaColors, buildReport, buildSankey, filterEntries, OTHER_COLOR, reportRange, UNCATEGORIZED, type ReportEntry } from "@/lib/reports";

const cat = (id: string, name: string, parent: string | null = null, type = "expense", sort = 0): Category =>
  ({ id, name, parent_category_id: parent, category_type: type, sort_order: sort, color: "#000", active: true }) as Category;

const cats = buildCategoryIndex([
  cat("food", "Food", null, "expense", 1),
  cat("groc", "Groceries", "food"),
  cat("rest", "Restaurants", "food"),
  cat("home", "Housing", null, "expense", 0),
  cat("rent", "Rent", "home"),
  cat("pay", "Paycheck", null, "income", 5),
]);
let n = 0;
const e = (
  date: string,
  amount: number,
  category: string | null,
  type = amount > 0 ? "income" : "expense",
  merchant = "Shop",
  account = "a1",
): ReportEntry => ({
  transaction_id: `t${n++}`,
  account_id: account,
  transaction_date: date,
  merchant_name: merchant,
  amount,
  category_id: category,
  transaction_type: type,
});

const entries = [
  e("2026-08-01", 5000, "pay"),
  e("2026-09-01", 5000, "pay"),
  e("2026-08-03", -2000, "rent", "expense", "Landlord"),
  e("2026-09-03", -2000, "rent", "expense", "Landlord"),
  e("2026-08-10", -300, "groc", "expense", "Trader Joe's"),
  e("2026-08-12", 50, "groc", "refund", "Trader Joe's"),
  e("2026-09-14", -120, "rest", "expense", "Taco Place", "a2"),
  e("2026-09-20", -80, null, "expense", "Mystery"),
];
const range = { from: "2026-08-01", to: "2026-09-30" };
const report = buildReport(entries, range, cats, areaColors(cats.parents), (id) => id.toUpperCase());

describe("report", () => {
  it("totals income and spending net of refunds", () => {
    expect(report.income).toBe(10000);
    expect(report.spending).toBe(2000 + 2000 + 300 - 50 + 120 + 80);
    expect(report.net).toBe(10000 - 4450);
    expect(report.savingsRate).toBeCloseTo(5550 / 10000);
    expect(report.months).toBe(2);
    expect(report.monthly).toEqual([
      { month: "2026-08-01", income: 5000, spending: 2250 },
      { month: "2026-09-01", income: 5000, spending: 2200 },
    ]);
  });

  it("groups categories under their top-level group, largest first, with uncategorized on its own", () => {
    expect(report.areas.map((a) => [a.name, a.amount])).toEqual([
      ["Housing", 4000],
      ["Food", 370],
      ["Uncategorized", 80],
    ]);
    expect(report.areas[1].children.map((c) => [c.name, c.amount])).toEqual([
      ["Groceries", 250],
      ["Restaurants", 120],
    ]);
  });

  it("colors groups by their category order, not by size, and uncategorized gray", () => {
    expect(report.areas.find((a) => a.id === "home")!.color).toBe(AREA_PALETTE[0]);
    expect(report.areas.find((a) => a.id === "food")!.color).toBe(AREA_PALETTE[1]);
    expect(report.areas.find((a) => a.id === UNCATEGORIZED)!.color).toBe(OTHER_COLOR);
  });

  it("ranks merchants, accounts and weekdays", () => {
    expect(report.merchants[0]).toEqual({ name: "Landlord", amount: 4000, count: 2 });
    expect(report.merchants.find((m) => m.name === "Trader Joe's")).toEqual({ name: "Trader Joe's", amount: 250, count: 2 });
    expect(report.accounts.map((a) => [a.name, a.amount])).toEqual([
      ["A1", 4330],
      ["A2", 120],
    ]);
    // Aug 3, Aug 10 and Sep 14 are Mondays; refunds don't count as purchases.
    expect(report.weekdays[0]).toEqual({ day: "Mon", amount: 2420, count: 3 });
    expect(report.weekdays.reduce((s, w) => s + w.count, 0)).toBe(5);
    expect(report.largest[0].amount).toBe(-2000);
  });

  it("filters by account, category (a group includes its subcategories) and merchant", () => {
    const f = (o: Partial<{ accountIds: string[]; categoryIds: string[]; search: string }>) =>
      filterEntries(entries, { accountIds: [], categoryIds: [], search: "", ...o }, cats).length;
    expect(f({ accountIds: ["a2"] })).toBe(1);
    expect(f({ categoryIds: ["food"] })).toBe(3);
    expect(f({ categoryIds: [UNCATEGORIZED] })).toBe(1);
    expect(f({ search: "trader" })).toBe(2);
  });

  it("balances the sankey: income in, spending and savings out", () => {
    const s = buildSankey(report, "both");
    expect(s.total).toBe(10000);
    const out = s.links.filter((l) => l.source === "hub").reduce((x, l) => x + l.value, 0);
    expect(out).toBeCloseTo(10000);
    expect(s.nodes.find((n) => n.id === "saved")!.value).toBe(5550);
    expect(s.nodes.filter((n) => n.column === 3).map((n) => n.name)).toEqual(["Rent", "Groceries", "Restaurants"]);
    // Uncategorized has no categories under it, so it ends at the group column.
    expect(s.nodes.filter((n) => n.name === "Uncategorized").map((n) => n.column)).toEqual([2]);
    expect(buildSankey(report, "areas").nodes.some((n) => n.column === 3)).toBe(false);
  });

  it("adds a 'From savings' source when spending beyond income", () => {
    const over = buildReport([e("2026-08-01", 1000, "pay"), e("2026-08-02", -1500, "rent")], range, cats, areaColors(cats.parents), (x) => x);
    const s = buildSankey(over, "areas");
    expect(s.nodes.find((n) => n.name === "From savings")!.value).toBe(500);
    expect(s.nodes.some((n) => n.id === "saved")).toBe(false);
    expect(s.total).toBe(1500);
  });
});

describe("report periods", () => {
  const now = new Date(2026, 9, 6);
  it("covers whole months", () => {
    expect(reportRange("last_3_months", {}, now)).toEqual({ from: "2026-08-01", to: "2026-10-31" });
    expect(reportRange("last_month", {}, now)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(reportRange("last_year", {}, now)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(reportRange("custom", { from: "2026-02-10", to: "2026-01-01" }, now)).toEqual({ from: "2026-02-10", to: "2026-02-28" });
  });
});
