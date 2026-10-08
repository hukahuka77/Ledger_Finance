/**
 * Money helpers. Postgres stores numeric(14,2); PostgREST hands us JS numbers.
 * Anything that adds or compares amounts goes through integer cents so we never
 * accumulate floating-point error.
 */

export const toCents = (n: number | string | null | undefined): number => {
  if (n === null || n === undefined || n === "") return 0;
  return Math.round(Number(n) * 100);
};

export const fromCents = (c: number): number => c / 100;

export const sumMoney = (values: (number | null | undefined)[]): number => fromCents(values.reduce<number>((acc, v) => acc + toCents(v), 0));

const fmt2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** $1,234.56 — magnitude only; callers decide how to show direction. */
export function formatMoney(amount: number | null | undefined, opts: { cents?: boolean } = {}): string {
  const v = Math.abs(Number(amount ?? 0));
  return (opts.cents === false ? fmt0 : fmt2).format(opts.cents === false ? Math.round(v) : v);
}

/**
 * Ledger display: outflows show as plain "$29.56", inflows as "+$2,500.00".
 * (Amounts are signed: negative = money out.)
 */
export function formatLedgerAmount(amount: number, opts: { cents?: boolean } = {}): string {
  const s = formatMoney(amount, opts);
  return amount > 0 ? `+${s}` : s;
}

/** Signed display for balances/net figures: "-$1,200" or "$1,200". */
export function formatSigned(amount: number, opts: { cents?: boolean } = {}): string {
  const s = formatMoney(amount, opts);
  return amount < 0 ? `-${s}` : s;
}

/** Parse user input like "$1,234.5", "(12.00)", "-3" → number rounded to cents, or null if invalid. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? fromCents(Math.round(input * 100)) : null;
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "").replace(/^USD/i, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents) || Math.abs(cents) >= 1e14) return null;
  return fromCents(negative ? -cents : cents);
}
