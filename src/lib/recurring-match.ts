/**
 * How a recurring item recognises its transactions: a list of phrases and whether
 * ANY or ALL of them must appear in the merchant name or bank description.
 * Mirrors public.recurring_text_matches in the database.
 */
export type MatchMode = "any" | "all";

export const MAX_MATCH_PATTERNS = 10;

export function recurringPatterns(item: { match_patterns?: string[] | null; merchant_pattern?: string | null }): string[] {
  const list = (item.match_patterns ?? []).map((p) => p.trim()).filter(Boolean);
  if (list.length) return list;
  const legacy = item.merchant_pattern?.trim();
  return legacy ? [legacy] : [];
}

/** Trim, drop blanks and case-insensitive duplicates, cap at MAX_MATCH_PATTERNS. */
export function cleanPatterns(patterns: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim().slice(0, 200);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out.slice(0, MAX_MATCH_PATTERNS);
}

export function matchesRecurring(patterns: string[], mode: MatchMode, merchant: string, description?: string | null): boolean {
  const ps = cleanPatterns(patterns).map((p) => p.toLowerCase());
  if (!ps.length) return false;
  const hay = [merchant.toLowerCase(), (description ?? "").toLowerCase()];
  const hit = (p: string) => hay.some((h) => h.includes(p));
  return mode === "all" ? ps.every(hit) : ps.some(hit);
}

/** e.g. `“ATT” or “phone”`, `“ATT” and “phone”`. */
export function describePatterns(patterns: string[], mode: MatchMode): string {
  const quoted = patterns.map((p) => `“${p}”`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} ${mode === "all" ? "and" : "or"} ${quoted[quoted.length - 1]}`;
}
