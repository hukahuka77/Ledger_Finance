import { describe, expect, it } from "vitest";
import { formatLedgerAmount, parseMoney, sumMoney } from "@/lib/money";

describe("money", () => {
  it("parses user input", () => {
    expect(parseMoney("$1,234.56")).toBe(1234.56);
    expect(parseMoney("(12.00)")).toBe(-12);
    expect(parseMoney("-3")).toBe(-3);
    expect(parseMoney("12.345")).toBe(12.35);
    expect(parseMoney("abc")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
  it("sums without float drift", () => {
    expect(sumMoney([0.1, 0.2, 0.3])).toBe(0.6);
  });
  it("formats ledger amounts", () => {
    expect(formatLedgerAmount(-29.56)).toBe("$29.56");
    expect(formatLedgerAmount(2500)).toBe("+$2,500.00");
  });
});
