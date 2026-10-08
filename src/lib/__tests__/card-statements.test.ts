import { describe, expect, it } from "vitest";
import { cardStatementPatch, liabilitiesStatusForError } from "@/lib/plaid/mapping";

describe("card statements from Plaid Liabilities", () => {
  it("maps statement balance, due date and close date onto the account", () => {
    expect(
      cardStatementPatch({
        account_id: "a",
        last_statement_balance: 1240.183,
        last_statement_issue_date: "2026-09-25",
        minimum_payment_amount: 40,
        next_payment_due_date: "2026-10-22",
        last_payment_amount: 980,
        last_payment_date: "2026-09-20",
        is_overdue: false,
      }),
    ).toEqual({
      statement_balance: 1240.18,
      minimum_payment: 40,
      next_payment_due_date: "2026-10-22",
      payment_due_day: 22,
      last_statement_date: "2026-09-25",
      statement_close_day: 25,
      last_payment_amount: 980,
      last_payment_date: "2026-09-20",
      is_overdue: false,
    });
  });

  it("leaves out what the issuer didn't report, so hand-entered values survive", () => {
    expect(
      cardStatementPatch({
        account_id: "a",
        last_statement_balance: null,
        last_statement_issue_date: null,
        minimum_payment_amount: null,
        next_payment_due_date: "2026-11-03",
        last_payment_amount: null,
        last_payment_date: null,
        is_overdue: null,
      }),
    ).toEqual({ next_payment_due_date: "2026-11-03", payment_due_day: 3 });
  });

  it("classifies Liabilities errors", () => {
    expect(liabilitiesStatusForError("ADDITIONAL_CONSENT_REQUIRED")).toBe("consent_required");
    expect(liabilitiesStatusForError("PRODUCTS_NOT_SUPPORTED")).toBe("unsupported");
    expect(liabilitiesStatusForError("PRODUCT_NOT_READY")).toBe("pending");
    expect(liabilitiesStatusForError("INVALID_PRODUCT")).toBe("not_enabled");
    expect(liabilitiesStatusForError(undefined)).toBe("error");
  });
});
