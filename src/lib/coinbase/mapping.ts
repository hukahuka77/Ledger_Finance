/**
 * Pure mapping from the Coinbase App API (v2) to the ledger's data model. No I/O,
 * so it can be unit-tested and shared by the server sync and the client.
 */
import type { TransactionType } from "@/lib/domain";

export interface CbMoney {
  amount: string;
  currency: string;
}

export interface CbAccount {
  id: string;
  name: string;
  currency: string | { code: string; name?: string };
  balance: CbMoney;
  native_balance?: CbMoney;
  updated_at?: string;
}

export interface CbTransaction {
  id: string;
  type: string;
  status: string;
  amount: CbMoney;
  native_amount?: CbMoney;
  description?: string | null;
  created_at: string;
  details?: { title?: string | null; subtitle?: string | null; header?: string | null } | null;
}

/** One wallet as stored on the connection after a sync. */
export interface WalletSnapshot {
  id: string;
  currency: string;
  name: string;
  balance: number;
  usd: number | null;
  /** Has had at least one transaction, so it is worth polling on later syncs. */
  active: boolean;
}

export interface MappedTransaction {
  coinbase_transaction_id: string;
  transaction_date: string;
  posted_date: string | null;
  status: "pending" | "posted";
  amount: number;
  merchant_name: string;
  original_description: string;
  transaction_type: TransactionType;
}

const SKIP_STATUSES = new Set(["failed", "canceled", "cancelled", "expired", "declined"]);
const PENDING_STATUSES = new Set(["pending", "waiting_for_signature", "waiting_for_clearing", "processing"]);
const INCOME_TYPES = new Set(["staking_reward", "inflation_reward", "interest", "earn_payout", "incentives_rewards_payout", "reward"]);

export const currencyCode = (c: CbAccount["currency"]) => (typeof c === "string" ? c : c.code).toUpperCase();

const round2 = (n: number) => Math.round(n * 100) / 100;

/** USD value of `amount` units of `currency`, given rates as units per 1 USD. */
export function toUsd(amount: number, currency: string, rates: Record<string, string>): number | null {
  if (currency.toUpperCase() === "USD") return amount;
  const rate = Number(rates[currency.toUpperCase()]);
  if (!rate || !Number.isFinite(rate)) return null;
  return amount / rate;
}

/** USD value of a wallet's balance. */
export function walletUsd(a: CbAccount, rates: Record<string, string>): number | null {
  if (a.native_balance?.currency?.toUpperCase() === "USD") return Number(a.native_balance.amount);
  return toUsd(Number(a.balance.amount), currencyCode(a.currency), rates);
}

/** Total USD value across wallets, to the cent. Wallets without a known rate count as zero. */
export const totalUsd = (wallets: Pick<WalletSnapshot, "usd">[]) => round2(wallets.reduce((s, w) => s + (w.usd ?? 0), 0));

/** Strip trailing zeros: "0.00150000" → "0.0015", "-12.50" → "-12.5". */
function trimAmount(a: string): string {
  return a.includes(".") ? a.replace(/0+$/, "").replace(/\.$/, "") : a;
}

function label(t: CbTransaction, code: string, inflow: boolean): string {
  switch (t.type) {
    case "buy":
      return `Buy ${code}`;
    case "sell":
      return `Sell ${code}`;
    case "send":
      return inflow ? `Received ${code}` : `Sent ${code}`;
    case "fiat_deposit":
      return "Deposit to Coinbase";
    case "fiat_withdrawal":
      return "Withdrawal from Coinbase";
    case "trade":
      return inflow ? `Convert to ${code}` : `Convert from ${code}`;
    case "advanced_trade_fill":
      return inflow ? `Advanced Trade buy ${code}` : `Advanced Trade sell ${code}`;
    case "staking_reward":
    case "inflation_reward":
      return `${code} staking reward`;
    case "interest":
    case "earn_payout":
    case "reward":
    case "incentives_rewards_payout":
      return `${code} rewards`;
    case "card_spend":
      return t.details?.title?.trim() || t.description?.trim() || "Coinbase Card purchase";
    default: {
      const words = t.type.replace(/_/g, " ");
      return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${code}`;
    }
  }
}

function ledgerType(t: CbTransaction, inflow: boolean): TransactionType {
  if (INCOME_TYPES.has(t.type)) return inflow ? "income" : "transfer";
  if (t.type === "card_spend") return inflow ? "refund" : "expense";
  // Buys, sells, sends, deposits and converts move money between the user's own places.
  return "transfer";
}

/**
 * Map one Coinbase transaction. Returns null for ones the ledger should not record
 * (failed/canceled, or no USD value can be determined).
 */
export function mapCoinbaseTransaction(t: CbTransaction, walletCurrency: string, rates: Record<string, string>): MappedTransaction | null {
  const status = t.status?.toLowerCase() ?? "completed";
  if (SKIP_STATUSES.has(status)) return null;
  const units = Number(t.amount.amount);
  const code = (t.amount.currency || walletCurrency).toUpperCase();
  let usd = t.native_amount && t.native_amount.currency?.toUpperCase() === "USD" ? Number(t.native_amount.amount) : toUsd(units, code, rates);
  if (usd === null || !Number.isFinite(usd)) return null;
  usd = round2(usd);
  // Dust (under half a cent) isn't worth a ledger row.
  if (usd === 0) return null;
  const inflow = usd > 0;
  const date = t.created_at.slice(0, 10);
  const pending = PENDING_STATUSES.has(status);
  const what = t.description?.trim() || t.details?.title?.trim() || t.type.replace(/_/g, " ");
  return {
    coinbase_transaction_id: t.id,
    transaction_date: date,
    posted_date: pending ? null : date,
    status: pending ? "pending" : "posted",
    amount: usd,
    merchant_name: label(t, code, inflow).slice(0, 200),
    original_description: `${what} · ${trimAmount(t.amount.amount)} ${code}`.slice(0, 500),
    transaction_type: ledgerType(t, inflow),
  };
}
