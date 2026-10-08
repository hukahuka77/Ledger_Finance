import { describe, expect, it } from "vitest";
import { buildCalendar, nextDueDate, scheduleDates } from "@/lib/calendar";
import type { Account, RecurringItem } from "@/lib/domain";

const item = (o: Partial<RecurringItem> = {}): RecurringItem => ({
  id: "r1",
  workspace_id: "w",
  name: "Netflix",
  merchant_pattern: "netflix",
  match_patterns: ["netflix"],
  match_mode: "any",
  account_id: null,
  category_id: null,
  recurring_type: "subscription",
  expected_amount: 22.99,
  amount_type: "fixed",
  frequency: "monthly",
  interval_value: 1,
  next_expected_date: "2026-10-08",
  end_date: null,
  notes: null,
  active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "",
  ...o,
});

describe("calendar", () => {
  it("projects monthly dates without month-end drift", () => {
    expect(scheduleDates(item({ next_expected_date: "2026-01-31" }), "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("replaces a projection with the matched actual transaction", () => {
    const ev = buildCalendar({
      from: "2026-10-01",
      to: "2026-10-31",
      today: "2026-10-15",
      items: [item()],
      occurrences: [],
      accounts: [],
      reminders: [],
      transactions: [
        {
          id: "t1",
          transaction_date: "2026-10-09",
          amount: -22.99,
          recurring_item_id: "r1",
          account_id: "a",
          transaction_type: "expense",
          merchant_name: "Netflix",
        },
      ],
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ status: "paid", transactionId: "t1", date: "2026-10-09" });
  });

  it("shows future occurrences as projected and recent misses as overdue", () => {
    const ev = buildCalendar({
      from: "2026-10-01",
      to: "2026-11-30",
      today: "2026-10-20",
      items: [item()],
      occurrences: [],
      accounts: [],
      reminders: [],
      transactions: [],
    });
    expect(ev.map((e) => [e.date, e.status])).toEqual([
      ["2026-10-08", "overdue"],
      ["2026-11-08", "projected"],
    ]);
  });

  it("honours skipped occurrences", () => {
    const ev = buildCalendar({
      from: "2026-11-01",
      to: "2026-11-30",
      today: "2026-10-20",
      items: [item()],
      accounts: [],
      reminders: [],
      transactions: [],
      occurrences: [
        {
          id: "o",
          workspace_id: "w",
          recurring_item_id: "r1",
          expected_date: "2026-11-08",
          expected_amount: null,
          status: "skipped",
          transaction_id: null,
          notes: null,
          created_at: "",
          updated_at: "",
        },
      ],
    });
    expect(ev[0].status).toBe("skipped");
  });

  it("computes the next unmatched due date", () => {
    expect(nextDueDate(item({ next_expected_date: "2026-09-08" }), [{ id: "t", transaction_date: "2026-09-08" }], "2026-09-05")).toBe("2026-10-08");
  });
});

const card = (o: Partial<Account> = {}): Account => ({
  id: "c1",
  workspace_id: "w",
  name: "Sapphire",
  institution: "Chase",
  account_type: "credit_card",
  last_four: "1234",
  currency: "USD",
  current_balance: 900,
  available_balance: null,
  balance_as_of: "2026-10-15",
  credit_limit: 10000,
  statement_balance: 1240.18,
  minimum_payment: 40,
  statement_close_day: 25,
  payment_due_day: 21,
  autopay_enabled: true,
  autopay_account_id: null,
  notes: null,
  sort_order: 0,
  active: true,
  created_at: "",
  updated_at: "",
  plaid_item_id: null,
  plaid_account_id: null,
  sync_from: null,
  next_payment_due_date: "2026-10-22",
  last_statement_date: "2026-09-25",
  last_payment_amount: 980,
  last_payment_date: "2026-09-20",
  is_overdue: false,
  track_transactions: true,
  ...o,
});
const cardEvents = (a: Account, today = "2026-10-15", txns: Parameters<typeof buildCalendar>[0]["transactions"] = []) =>
  buildCalendar({ from: "2026-10-01", to: "2026-11-30", today, items: [], occurrences: [], accounts: [a], reminders: [], transactions: txns }).filter(
    (e) => e.source === "card",
  );

describe("card statements on the calendar", () => {
  it("puts the statement balance on the bank's exact due date, and estimates later months", () => {
    const [oct, nov] = cardEvents(card());
    expect(oct).toMatchObject({ date: "2026-10-22", amount: 1240.18, approximate: false, status: "projected" });
    expect(nov).toMatchObject({ date: "2026-11-21", amount: 900, approximate: true, status: "projected" });
  });

  it("shows the due date as paid once the bank reports a payment covering the statement", () => {
    const [oct] = cardEvents(card({ last_payment_amount: 1240.18, last_payment_date: "2026-10-14" }));
    expect(oct).toMatchObject({ status: "paid", amount: 1240.18 });
  });

  it("flags overdue from the bank and treats a zero statement as nothing due", () => {
    expect(cardEvents(card({ is_overdue: true }))[0].status).toBe("overdue");
    expect(cardEvents(card({ statement_balance: 0 }))[0].status).toBe("paid");
  });

  it("works from the due date alone when no due day was entered", () => {
    const evs = cardEvents(card({ payment_due_day: null }));
    expect(evs.map((e) => e.date)).toEqual(["2026-10-22"]);
  });
});
