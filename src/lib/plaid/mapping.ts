/**
 * Pure mapping from Plaid's data model to the ledger's. No I/O here so it can be
 * unit-tested and shared by the client (account-mapping UI) and the server sync.
 */
import type { AccountType, TransactionType } from "@/lib/domain";

export interface PlaidAccountSnapshot {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
}

/** Minimal shape of a Plaid transaction that the sync relies on. */
export interface PlaidTxn {
  transaction_id: string;
  pending_transaction_id?: string | null;
  account_id: string;
  /** Plaid convention: positive = money out of the account. */
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  original_description?: string | null;
  pending: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
}

export function mapAccountType(type: string, subtype?: string | null): AccountType {
  const s = (subtype ?? "").toLowerCase();
  switch (type) {
    case "credit":
      return "credit_card";
    case "depository":
      return /saving|money market|cd|hsa/.test(s) ? "savings" : "checking";
    case "loan":
      return s === "mortgage" || s === "home equity" ? "mortgage" : "loan";
    case "investment":
      return /401|403|457|ira|roth|pension|retirement|keogh|sep|simple/.test(s) ? "retirement" : "brokerage";
    default:
      return "other";
  }
}

/** Ledger sign convention: negative = money out. Plaid's is the opposite. */
export const toLedgerAmount = (plaidAmount: number) => Math.round(-plaidAmount * 100) / 100;

export function mapTransactionType(t: Pick<PlaidTxn, "amount" | "personal_finance_category">, accountType: AccountType | undefined): TransactionType {
  const primary = t.personal_finance_category?.primary ?? "";
  const detailed = t.personal_finance_category?.detailed ?? "";
  const inflow = toLedgerAmount(t.amount) > 0;
  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" || (accountType === "credit_card" && inflow && primary === "TRANSFER_IN")) {
    return "credit_card_payment";
  }
  if (primary === "TRANSFER_IN" || primary === "TRANSFER_OUT") return "transfer";
  if (primary === "INCOME") return inflow ? "income" : "expense";
  return inflow ? "refund" : "expense";
}

/**
 * Candidate category names for a Plaid category, most specific first. The sync
 * picks the first one that exists in the user's own taxonomy; otherwise the
 * transaction stays uncategorized for rules or review.
 */
const DETAILED: Record<string, string[]> = {
  FOOD_AND_DRINK_COFFEE: ["Coffee"],
  FOOD_AND_DRINK_GROCERIES: ["Groceries"],
  FOOD_AND_DRINK_FAST_FOOD: ["Quick Eats (solo)", "Quick Eats", "Fast Food", "Restaurants"],
  FOOD_AND_DRINK_RESTAURANT: ["Restaurants"],
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: ["Bars & Nightlife", "Alcohol & Bars"],
  TRANSPORTATION_GAS: ["Gas", "Car"],
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: ["Rideshare", "Transportation"],
  TRANSPORTATION_PARKING: ["Parking", "Car"],
  TRANSPORTATION_PUBLIC_TRANSIT: ["Public Transit", "Transportation"],
  TRANSPORTATION_TOLLS: ["Car", "Transportation"],
  ENTERTAINMENT_CASINOS_AND_GAMBLING: ["Gambling"],
  ENTERTAINMENT_TV_AND_MOVIES: ["Streaming", "Entertainment"],
  ENTERTAINMENT_MUSIC_AND_AUDIO: ["Streaming", "Entertainment"],
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: ["Clothing"],
  RENT_AND_UTILITIES_RENT: ["Rent"],
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: ["Gym", "Sports/Fitness"],
  GENERAL_SERVICES_INSURANCE: ["Insurance", "Car Insurance"],
  GENERAL_SERVICES_EDUCATION: ["Education"],
  GENERAL_SERVICES_AUTOMOTIVE: ["Car Maintenance", "Car"],
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: ["Taxes and Fees", "Taxes"],
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: ["Gifts", "Donations"],
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: ["Mortgage", "Home"],
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: ["Loans"],
  LOAN_PAYMENTS_CAR_PAYMENT: ["Loans", "Car"],
  TRAVEL_FLIGHTS: ["Flights", "Travel & Vacation", "Travel"],
  TRAVEL_LODGING: ["Lodging", "Travel & Vacation", "Travel"],
};
const PRIMARY: Record<string, string[]> = {
  FOOD_AND_DRINK: ["Restaurants"],
  TRANSPORTATION: ["Transportation"],
  TRAVEL: ["Travel & Vacation", "Travel", "Vacation"],
  ENTERTAINMENT: ["Entertainment"],
  GENERAL_MERCHANDISE: ["Misc", "Shopping", "Miscellaneous"],
  HOME_IMPROVEMENT: ["Home Improvement", "Home"],
  RENT_AND_UTILITIES: ["Utilities"],
  MEDICAL: ["Healthcare", "Medical"],
  PERSONAL_CARE: ["Personal Care"],
  GENERAL_SERVICES: ["Misc", "Miscellaneous"],
  BANK_FEES: ["Taxes and Fees", "Fees"],
  LOAN_PAYMENTS: ["Loans"],
  GOVERNMENT_AND_NON_PROFIT: ["Taxes and Fees", "Taxes"],
  INCOME: ["Paycheck", "Income"],
};

export function categoryCandidates(pfc: PlaidTxn["personal_finance_category"]): string[] {
  if (!pfc) return [];
  return [...(DETAILED[pfc.detailed] ?? []), ...(PRIMARY[pfc.primary] ?? [])];
}

export function pickCategory(pfc: PlaidTxn["personal_finance_category"], byName: Map<string, string>): string | null {
  for (const name of categoryCandidates(pfc)) {
    const id = byName.get(name.toLowerCase());
    if (id) return id;
  }
  return null;
}

/** Title-case Plaid's raw names lightly ("UBER   *TRIP" → "Uber *trip") when there's no merchant name. */
export function cleanMerchant(t: Pick<PlaidTxn, "merchant_name" | "name">): string {
  const raw = (t.merchant_name || t.name || "Unknown").replace(/\s+/g, " ").trim();
  if (t.merchant_name) return raw.slice(0, 200);
  return (raw === raw.toUpperCase() ? raw.charAt(0) + raw.slice(1).toLowerCase() : raw).slice(0, 200);
}

/** Suggest which existing ledger account a Plaid account corresponds to. */
export function suggestAccountMatch<T extends { id: string; name: string; last_four: string | null; plaid_account_id?: string | null }>(
  p: PlaidAccountSnapshot,
  accounts: T[],
): T | undefined {
  const free = accounts.filter((a) => !a.plaid_account_id || a.plaid_account_id === p.account_id);
  const linked = free.find((a) => a.plaid_account_id === p.account_id);
  if (linked) return linked;
  if (p.mask) {
    const byMask = free.filter((a) => a.last_four === p.mask);
    if (byMask.length === 1) return byMask[0];
    const exact = byMask.find((a) => a.name.toLowerCase() === p.name.toLowerCase() || a.name.toLowerCase() === (p.official_name ?? "").toLowerCase());
    if (exact) return exact;
    const words = p.name
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2);
    const best = byMask.find((a) => words.some((w) => a.name.toLowerCase().includes(w)));
    if (best) return best;
  }
  const name = (p.official_name ?? p.name).toLowerCase();
  return free.find((a) => a.name.toLowerCase() === name || a.name.toLowerCase() === p.name.toLowerCase());
}

/** The parts of a Plaid Liabilities credit card entry the ledger uses. */
export interface PlaidCardLiability {
  account_id: string | null;
  last_statement_balance: number | null;
  last_statement_issue_date: string | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
}

export interface CardStatementPatch {
  statement_balance?: number;
  minimum_payment?: number;
  next_payment_due_date?: string;
  payment_due_day?: number;
  last_statement_date?: string;
  statement_close_day?: number;
  last_payment_amount?: number;
  last_payment_date?: string;
  is_overdue?: boolean;
}

const money = (n: number) => Math.round(n * 100) / 100;
const dayOf = (iso: string) => Number(iso.slice(8, 10));

/**
 * Account fields to update from a Liabilities entry. Fields the issuer didn't report are
 * left out, so values typed in by hand survive. The statement issue date is the day the
 * statement closes.
 */
export function cardStatementPatch(l: PlaidCardLiability): CardStatementPatch {
  const p: CardStatementPatch = {};
  if (l.last_statement_balance !== null && l.last_statement_balance !== undefined) p.statement_balance = money(l.last_statement_balance);
  if (l.minimum_payment_amount !== null && l.minimum_payment_amount !== undefined) p.minimum_payment = Math.max(0, money(l.minimum_payment_amount));
  if (l.next_payment_due_date) {
    p.next_payment_due_date = l.next_payment_due_date;
    p.payment_due_day = dayOf(l.next_payment_due_date);
  }
  if (l.last_statement_issue_date) {
    p.last_statement_date = l.last_statement_issue_date;
    p.statement_close_day = dayOf(l.last_statement_issue_date);
  }
  if (l.last_payment_amount !== null && l.last_payment_amount !== undefined) p.last_payment_amount = money(l.last_payment_amount);
  if (l.last_payment_date) p.last_payment_date = l.last_payment_date;
  if (l.is_overdue !== null && l.is_overdue !== undefined) p.is_overdue = l.is_overdue;
  return p;
}

/** How a /liabilities/get failure is shown: consent needed, not offered by the bank, still loading, etc. */
export function liabilitiesStatusForError(code: string | undefined): "pending" | "consent_required" | "unsupported" | "not_enabled" | "error" {
  switch (code) {
    case "ADDITIONAL_CONSENT_REQUIRED":
      return "consent_required";
    case "PRODUCTS_NOT_SUPPORTED":
    case "NO_LIABILITY_ACCOUNTS":
    case "INSTITUTION_NOT_SUPPORTED":
      return "unsupported";
    case "PRODUCT_NOT_READY":
      return "pending";
    case "INVALID_PRODUCT":
    case "PRODUCT_NOT_ENABLED":
      return "not_enabled";
    default:
      return "error";
  }
}
