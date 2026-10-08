import { describe, expect, it } from "vitest";
import { detectRecurring, normalizeMerchant, type DetectInputTxn } from "@/lib/recurring-detect";

let n = 0;
const t = (date: string, merchant: string, amount: number, extra: Partial<DetectInputTxn> = {}): DetectInputTxn => ({
  id: `t${n++}`,
  transaction_date: date,
  amount,
  merchant_name: merchant,
  account_id: "acc",
  category_id: null,
  transaction_type: amount > 0 ? "income" : "expense",
  recurring_item_id: null,
  ...extra,
});
const opts = { today: "2026-10-01", existingPatterns: [] as string[] };

describe("recurring detection", () => {
  it("normalizes noisy bank descriptions", () => {
    expect(normalizeMerchant("NETFLIX.COM 866-579-7172 CA")).toBe(normalizeMerchant("NETFLIX.COM 866-579-7999 CA"));
    expect(normalizeMerchant("Aps Electric Payments #12345")).toBe("aps electric payments");
  });

  it("finds a monthly subscription with a fixed amount", () => {
    const txns = ["2026-06-08", "2026-07-08", "2026-08-08", "2026-09-08"].map((d) => t(d, "Netflix", -22.99));
    const [s] = detectRecurring(txns, opts);
    expect(s).toMatchObject({
      name: "Netflix",
      frequency: "monthly",
      amount: 22.99,
      amountType: "fixed",
      recurringType: "subscription",
      nextDate: "2026-10-08",
      occurrences: 4,
    });
  });

  it("finds a variable monthly utility bill and biweekly income", () => {
    const util = [
      ["2026-06-06", -118.4],
      ["2026-07-06", -142.1],
      ["2026-08-05", -171.9],
      ["2026-09-06", -132.07],
    ].map(([d, a]) => t(d as string, "Aps Electric Payments", a as number));
    const pay = ["2026-07-17", "2026-07-31", "2026-08-14", "2026-08-28", "2026-09-11", "2026-09-25"].map((d) => t(d, "Acme Payroll", 2500));
    const found = detectRecurring([...util, ...pay], opts);
    expect(found.find((s) => s.name === "Aps Electric Payments")).toMatchObject({ frequency: "monthly", amountType: "estimated", recurringType: "bill" });
    expect(found.find((s) => s.name === "Acme Payroll")).toMatchObject({ frequency: "biweekly", recurringType: "income", nextDate: "2026-10-09" });
  });

  it("ignores irregular or variable frequent spending, lapsed series, and already-tracked merchants", () => {
    const coffee = ["2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07"].map((d, i) => t(d, "Blue Bottle", -(4 + i * 1.7)));
    const doordash = ["2026-07-02", "2026-07-19", "2026-07-21", "2026-08-30", "2026-09-04"].map((d) => t(d, "Doordash", -29.56));
    const lapsed = ["2026-01-27", "2026-02-27", "2026-03-27", "2026-04-27"].map((d) => t(d, "Dept Education Student Ln", -177.79));
    const tracked = ["2026-07-14", "2026-08-14", "2026-09-14"].map((d) => t(d, "Todoist", -5));
    const linked = ["2026-07-01", "2026-08-01", "2026-09-01"].map((d) => t(d, "Rent", -2000, { recurring_item_id: "r1" }));
    const found = detectRecurring([...coffee, ...doordash, ...lapsed, ...tracked, ...linked], { ...opts, existingPatterns: ["todoist"] });
    expect(found).toEqual([]);
  });

  it("honours dismissed suggestions", () => {
    const txns = ["2026-07-08", "2026-08-08", "2026-09-08"].map((d) => t(d, "Spotify", -11.99));
    const [s] = detectRecurring(txns, opts);
    expect(detectRecurring(txns, { ...opts, dismissed: new Set([s.key]) })).toEqual([]);
  });
});
