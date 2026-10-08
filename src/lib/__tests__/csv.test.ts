import { describe, expect, it } from "vitest";
import { detectMapping, fingerprintRows, guessAccountType, guessSignConvention, inferFrequency, normalizeRows, parseDate, resolveType } from "@/lib/import/csv";

const HEADERS = ["date", "name", "amount", "status", "category", "parent category", "excluded", "tags", "type", "account", "account mask", "note", "recurring"];
const row = (o: Partial<Record<string, string>>) => Object.fromEntries(HEADERS.map((h) => [h, o[h] ?? ""]));

describe("csv import", () => {
  it("detects Copilot-style columns", () => {
    const m = detectMapping(HEADERS);
    expect(m).toMatchObject({
      date: "date",
      merchant: "name",
      amount: "amount",
      status: "status",
      category: "category",
      parent_category: "parent category",
      excluded: "excluded",
      tags: "tags",
      type: "type",
      account: "account",
      account_mask: "account mask",
      notes: "note",
      recurring: "recurring",
    });
  });

  it("parses dates in several formats", () => {
    expect(parseDate("2026-09-27")).toBe("2026-09-27");
    expect(parseDate("9/27/2026")).toBe("2026-09-27");
    expect(parseDate("27/09/2026")).toBe("2026-09-27");
    expect(parseDate("03/04/2026", "dmy")).toBe("2026-04-03");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("nope")).toBeNull();
  });

  it("guesses positive-is-outflow when income rows are negative", () => {
    const m = detectMapping(HEADERS);
    const recs = [row({ amount: "29.56", type: "regular" }), row({ amount: "-2500", type: "income" }), row({ amount: "12", type: "regular" })];
    expect(guessSignConvention(recs, m)).toBe("positive_is_outflow");
  });

  it("normalises rows, flips signs and cleans NBSP", () => {
    const m = detectMapping(HEADERS);
    const [r] = normalizeRows(
      [
        row({
          date: "2026-09-27",
          name: "Doordash",
          amount: "29.56",
          status: "pending",
          account: "Apple Card",
          excluded: "false",
          tags: "#Vacation, Business",
        }),
      ],
      m,
      { signConvention: "positive_is_outflow", dateFormat: "auto", defaultAccountLabel: "", reviewedBefore: "" },
    );
    expect(r.errors).toEqual([]);
    expect(r.amount).toBe(-29.56);
    expect(r.accountName).toBe("Apple Card");
    expect(r.status).toBe("pending");
    expect(r.tags).toEqual(["Vacation", "Business"]);
  });

  it("flags invalid rows", () => {
    const m = detectMapping(HEADERS);
    const [r] = normalizeRows([row({ date: "", name: "", amount: "abc" })], m, {
      signConvention: "negative_is_outflow",
      dateFormat: "auto",
      defaultAccountLabel: "",
      reviewedBefore: "",
    });
    expect(r.errors).toHaveLength(3);
  });

  it("maps types so transfers and card payments never count as spending", () => {
    const base = { rawType: "internal transfer", amount: 1239.74 } as Parameters<typeof resolveType>[0];
    expect(resolveType(base, "credit_card", true)).toBe("credit_card_payment");
    expect(resolveType({ ...base, amount: -1239.74 }, "checking", true)).toBe("transfer");
    expect(resolveType({ ...base, rawType: "income", amount: 2000 }, "checking", true)).toBe("income");
    expect(resolveType({ ...base, rawType: "regular", amount: -29.56 }, "credit_card", true)).toBe("expense");
    expect(resolveType({ ...base, rawType: "regular", amount: 125 }, "checking", true)).toBe("refund");
  });

  it("fingerprints identical same-day rows distinctly but deterministically", async () => {
    const m = detectMapping(HEADERS);
    const opts = { signConvention: "positive_is_outflow" as const, dateFormat: "auto" as const, defaultAccountLabel: "", reviewedBefore: "" };
    const recs = [
      row({ date: "2026-09-25", name: "Uber", amount: "4.65", account: "Platinum" }),
      row({ date: "2026-09-25", name: "Uber", amount: "4.65", account: "Platinum" }),
    ];
    const a = await fingerprintRows(normalizeRows(recs, m, opts));
    const b = await fingerprintRows(normalizeRows(recs, m, opts));
    expect(a[0]).not.toBe(a[1]);
    expect(a).toEqual(b);
  });

  it("guesses account types and frequencies", () => {
    expect(guessAccountType("Home Mortgage")).toBe("mortgage");
    expect(guessAccountType("Student loan 1")).toBe("loan");
    expect(guessAccountType("Robinhood Savings")).toBe("savings");
    expect(guessAccountType("WF Checkings")).toBe("checking");
    expect(guessAccountType("American Express Gold Card")).toBe("credit_card");
    expect(guessAccountType("CareCredit Account")).toBe("credit_card");
    expect(guessAccountType("Venmo Money")).toBe("cash");
    expect(inferFrequency(["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-06"]).frequency).toBe("monthly");
    expect(inferFrequency(["2026-01-01", "2026-01-15", "2026-01-29"]).frequency).toBe("biweekly");
  });
});
