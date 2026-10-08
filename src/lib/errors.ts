import { toast } from "sonner";

type MaybePgError = { message?: string; code?: string; details?: string; hint?: string } | null | undefined;

/** User-safe message: surfaces our own validation messages, hides raw database internals. */
export function friendlyError(err: unknown, fallback: string): string {
  const e = err as MaybePgError;
  const code = e?.code;
  // Messages raised deliberately by our SQL functions / check triggers.
  if ((code === "22023" || code === "P0002" || code === "23514") && e?.message && !/violates check constraint/i.test(e.message)) {
    return e.message;
  }
  if (code === "23505") return "That name is already in use.";
  if (code === "23503") return "That item is referenced by something else or no longer exists.";
  if (code === "23514") return "Some values are out of range. Check the fields and try again.";
  if (code === "PGRST301" || code === "401" || /JWT/i.test(e?.message ?? "")) return "Your session expired. Sign in again.";
  return fallback;
}

/** Log for debugging (code + message only — never row data) and toast a concise error. */
export function reportError(err: unknown, fallback: string) {
  const e = err as MaybePgError;
  console.error("[finance]", fallback, e?.code ?? "", e?.message ?? err);
  toast.error(friendlyError(err, fallback));
}
