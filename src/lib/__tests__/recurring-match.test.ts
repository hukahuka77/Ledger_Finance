import { describe, expect, it } from "vitest";
import { cleanPatterns, describePatterns, matchesRecurring, recurringPatterns } from "@/lib/recurring-match";

describe("recurring matching", () => {
  it("matches any phrase in the merchant or the bank description", () => {
    expect(matchesRecurring(["ATT", "phone"], "any", "AT&T Wireless", "ATT*BILL PAYMENT")).toBe(true);
    expect(matchesRecurring(["ATT", "phone"], "any", "Verizon", "monthly phone bill")).toBe(true);
    expect(matchesRecurring(["ATT", "phone"], "any", "Verizon", "wireless")).toBe(false);
  });

  it("requires every phrase in 'all' mode, across merchant and description together", () => {
    expect(matchesRecurring(["att", "phone"], "all", "ATT", "PHONE PAYMENT")).toBe(true);
    expect(matchesRecurring(["att", "phone"], "all", "ATT", "internet")).toBe(false);
  });

  it("ignores blanks and duplicates and falls back to the legacy single pattern", () => {
    expect(cleanPatterns([" ATT ", "", "att", "Phone"])).toEqual(["ATT", "Phone"]);
    expect(matchesRecurring(["", "  "], "any", "anything")).toBe(false);
    expect(recurringPatterns({ match_patterns: [], merchant_pattern: "Netflix" })).toEqual(["Netflix"]);
    expect(recurringPatterns({ match_patterns: ["ATT", "phone"], merchant_pattern: "ATT" })).toEqual(["ATT", "phone"]);
  });

  it("describes the rule in words", () => {
    expect(describePatterns(["ATT", "phone"], "any")).toBe("“ATT” or “phone”");
    expect(describePatterns(["a", "b", "c"], "all")).toBe("“a”, “b” and “c”");
  });
});
