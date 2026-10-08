import type { Tables } from "@/lib/database.types";

export type Account = Tables<"accounts">;
export type Category = Tables<"categories">;
export type Tag = Tables<"tags">;
export type Transaction = Tables<"transactions">;
export type TransactionSplit = Tables<"transaction_splits">;
export type RecurringItem = Tables<"recurring_items">;
export type RecurringOccurrence = Tables<"recurring_occurrences">;
export type CalendarReminder = Tables<"calendar_reminders">;
export type CategorizationRule = Tables<"categorization_rules">;
export type ImportRecord = Tables<"imports">;

/** A transaction row as loaded by the ledger (with tags and splits embedded). */
export type LedgerTransaction = Transaction & {
  transaction_tags: { tag_id: string }[];
  transaction_splits: Pick<TransactionSplit, "id" | "category_id" | "amount" | "notes" | "sort_order">[];
};

function options<T extends string>(entries: Record<T, string>) {
  return Object.entries(entries).map(([value, label]) => ({ value: value as T, label: label as string }));
}

export const TRANSACTION_TYPES = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
  credit_card_payment: "Credit card payment",
  refund: "Refund",
  adjustment: "Adjustment",
} as const;
export type TransactionType = keyof typeof TRANSACTION_TYPES;
export const TRANSACTION_TYPE_OPTIONS = options(TRANSACTION_TYPES);

/** Types that never count toward spending or income. */
export const NON_COUNTING_TYPES: TransactionType[] = ["transfer", "credit_card_payment", "adjustment"];

export const ACCOUNT_TYPES = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit cards",
  brokerage: "Brokerage",
  retirement: "Retirement",
  loan: "Loans",
  mortgage: "Mortgage",
  cash: "Cash",
  other: "Other",
} as const;
export type AccountType = keyof typeof ACCOUNT_TYPES;
export const ACCOUNT_TYPE_OPTIONS = options(ACCOUNT_TYPES);
export const ACCOUNT_TYPE_SINGULAR: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  brokerage: "Brokerage",
  retirement: "Retirement",
  loan: "Loan",
  mortgage: "Mortgage",
  cash: "Cash",
  other: "Other",
};
export const LIABILITY_TYPES: AccountType[] = ["credit_card", "loan", "mortgage"];
export const isLiability = (t: string) => LIABILITY_TYPES.includes(t as AccountType);

export const CATEGORY_TYPES = { expense: "Expense", income: "Income", transfer: "Transfer (not counted)" } as const;
export const CATEGORY_TYPE_OPTIONS = options(CATEGORY_TYPES);

/** Business workspaces: categories are a chart of accounts, and the type is the account class. */
export const BUSINESS_CATEGORY_TYPES = {
  income: "Revenue",
  cost_of_goods: "Cost of goods sold",
  expense: "Operating expense",
  equity: "Owner's equity (not counted)",
  transfer: "Transfer (not counted)",
} as const;
export type BusinessCategoryType = keyof typeof BUSINESS_CATEGORY_TYPES;
export const BUSINESS_CATEGORY_TYPE_OPTIONS = options(BUSINESS_CATEGORY_TYPES);
/** Section headings for the chart of accounts, in statement order. */
export const BUSINESS_CLASS_HEADINGS: Record<BusinessCategoryType, string> = {
  income: "Revenue",
  cost_of_goods: "Cost of goods sold",
  expense: "Operating expenses",
  equity: "Owner's equity",
  transfer: "Transfers",
};

export const RECURRING_TYPES = {
  subscription: "Subscription",
  bill: "Bill",
  credit_card_payment: "Credit card payment",
  transfer: "Transfer",
  income: "Income",
  loan: "Loan",
  other: "Other",
} as const;
export type RecurringType = keyof typeof RECURRING_TYPES;
export const RECURRING_TYPE_OPTIONS = options(RECURRING_TYPES);

export const FREQUENCIES = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Every 6 months",
  annual: "Annually",
  custom: "Custom",
} as const;
export type Frequency = keyof typeof FREQUENCIES;
export const FREQUENCY_OPTIONS = options(FREQUENCIES);

export const AMOUNT_TYPES = { fixed: "Fixed", estimated: "Estimated", variable: "Variable" } as const;
export const AMOUNT_TYPE_OPTIONS = options(AMOUNT_TYPES);

export const EVENT_TYPES = {
  subscription: "Subscription",
  credit_card_payment: "Credit card payment",
  bill: "Bill",
  transfer: "Transfer",
  income: "Income",
  other: "Other",
} as const;
export type EventType = keyof typeof EVENT_TYPES;
export const EVENT_TYPE_OPTIONS = options(EVENT_TYPES);

/** Muted, paper-friendly swatches used for categories, tags and chart marks. */
export const SWATCHES = [
  "#C96442", // terracotta
  "#A65A4E", // brick
  "#C49A45", // ochre
  "#8A8D5A", // olive
  "#7D9A78", // sage
  "#5E8C87", // teal
  "#6B7F99", // slate
  "#7A7296", // dusk
  "#8C6A8F", // plum
  "#B67B7B", // rose
  "#A89060", // sand
  "#8A847C", // stone
] as const;

export const EVENT_TYPE_COLORS: Record<EventType, string> = {
  subscription: "#8C6A8F",
  credit_card_payment: "#6B7F99",
  bill: "#C96442",
  transfer: "#8A847C",
  income: "#7D9A78",
  other: "#A89060",
};

export const RECURRING_TO_EVENT: Record<RecurringType, EventType> = {
  subscription: "subscription",
  bill: "bill",
  credit_card_payment: "credit_card_payment",
  transfer: "transfer",
  income: "income",
  loan: "bill",
  other: "other",
};

export const RULE_FIELDS = {
  merchant: "Merchant",
  description: "Original description",
  account: "Account",
  amount: "Amount",
} as const;
export type RuleField = keyof typeof RULE_FIELDS;

export const RULE_OPS: Record<RuleField, { value: string; label: string }[]> = {
  merchant: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "starts_with", label: "starts with" },
  ],
  description: [
    { value: "contains", label: "contains" },
    { value: "equals", label: "equals" },
    { value: "starts_with", label: "starts with" },
  ],
  account: [{ value: "equals", label: "is" }],
  amount: [
    { value: "equals", label: "equals" },
    { value: "gt", label: "greater than" },
    { value: "lt", label: "less than" },
  ],
};

export type RuleCondition = { field: RuleField; op: string; value: string };
export type RuleActions = {
  category_id?: string;
  transaction_type?: TransactionType;
  tag_id?: string;
  recurring_item_id?: string;
  merchant_name?: string;
};
