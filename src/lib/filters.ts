/** Transaction ledger filters, serialised to/from the URL so views can be bookmarked. */

export type ReviewFilter = "all" | "unreviewed" | "reviewed";
export type SortKey = "newest" | "oldest" | "amount_desc" | "amount_asc" | "merchant_asc" | "merchant_desc";

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "amount_desc", label: "Amount: high → low" },
  { value: "amount_asc", label: "Amount: low → high" },
  { value: "merchant_asc", label: "Merchant A–Z" },
  { value: "merchant_desc", label: "Merchant Z–A" },
];

export const UNCATEGORIZED = "none";

export interface TransactionFilters {
  q: string;
  review: ReviewFilter;
  accounts: string[];
  /** Category ids; a parent id also matches its subcategories. `none` = uncategorized. */
  categories: string[];
  types: string[];
  tags: string[];
  status: "" | "pending" | "posted";
  recurring: "" | "yes" | "no";
  excluded: "" | "yes" | "no";
  from: string;
  to: string;
  /** Magnitude bounds, in dollars. */
  min: string;
  max: string;
  sort: SortKey;
}

export const DEFAULT_FILTERS: TransactionFilters = {
  q: "",
  review: "all",
  accounts: [],
  categories: [],
  types: [],
  tags: [],
  status: "",
  recurring: "",
  excluded: "",
  from: "",
  to: "",
  min: "",
  max: "",
  sort: "newest",
};

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NUM_RE = /^\d+(\.\d{1,2})?$/;

export function parseFilters(sp: URLSearchParams): TransactionFilters {
  const review = sp.get("review");
  const sort = sp.get("sort");
  const status = sp.get("status");
  const recurring = sp.get("recurring");
  const excluded = sp.get("excluded");
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  const min = sp.get("min") ?? "";
  const max = sp.get("max") ?? "";
  return {
    q: (sp.get("q") ?? "").slice(0, 200),
    review: review === "unreviewed" || review === "reviewed" ? review : "all",
    accounts: list(sp.get("account")),
    categories: list(sp.get("category")),
    types: list(sp.get("type")),
    tags: list(sp.get("tag")),
    status: status === "pending" || status === "posted" ? status : "",
    recurring: recurring === "yes" || recurring === "no" ? recurring : "",
    excluded: excluded === "yes" || excluded === "no" ? excluded : "",
    from: DATE_RE.test(from) ? from : "",
    to: DATE_RE.test(to) ? to : "",
    min: NUM_RE.test(min) ? min : "",
    max: NUM_RE.test(max) ? max : "",
    sort: SORT_OPTIONS.some((o) => o.value === sort) ? (sort as SortKey) : "newest",
  };
}

export function filtersToParams(f: TransactionFilters, base?: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(base);
  const set = (k: string, v: string) => (v ? sp.set(k, v) : sp.delete(k));
  set("q", f.q.trim());
  set("review", f.review === "all" ? "" : f.review);
  set("account", f.accounts.join(","));
  set("category", f.categories.join(","));
  set("type", f.types.join(","));
  set("tag", f.tags.join(","));
  set("status", f.status);
  set("recurring", f.recurring);
  set("excluded", f.excluded);
  set("from", f.from);
  set("to", f.to);
  set("min", f.min);
  set("max", f.max);
  set("sort", f.sort === "newest" ? "" : f.sort);
  return sp;
}

/** Number of active filters, excluding search, review tab and sort (those have their own controls). */
export function activeFilterCount(f: TransactionFilters): number {
  return (
    (f.accounts.length ? 1 : 0) +
    (f.categories.length ? 1 : 0) +
    (f.types.length ? 1 : 0) +
    (f.tags.length ? 1 : 0) +
    (f.status ? 1 : 0) +
    (f.recurring ? 1 : 0) +
    (f.excluded ? 1 : 0) +
    (f.from || f.to ? 1 : 0) +
    (f.min || f.max ? 1 : 0)
  );
}
