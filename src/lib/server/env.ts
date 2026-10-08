import "server-only";

/** Server-side configuration. Secrets live only in environment variables, never in NEXT_PUBLIC_*. */
export const serverEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  /** Optional. Enables background sync (Plaid webhooks + daily cron). */
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  plaidClientId: process.env.PLAID_CLIENT_ID ?? "",
  plaidSecret: process.env.PLAID_SECRET ?? "",
  plaidEnv: (process.env.PLAID_ENV ?? "sandbox") as "sandbox" | "production",
  /** 32 random bytes, base64. Encrypts Plaid access tokens and Coinbase API keys at rest. */
  plaidTokenKey: process.env.PLAID_TOKEN_KEY ?? "",
  /** Shared secret Vercel Cron sends as a bearer token. */
  cronSecret: process.env.CRON_SECRET ?? "",
};

export function plaidConfigured() {
  return Boolean(serverEnv.plaidClientId && serverEnv.plaidSecret && serverEnv.plaidTokenKey);
}

export function backgroundSyncConfigured() {
  return plaidConfigured() && Boolean(serverEnv.supabaseServiceRoleKey);
}

/** Coinbase needs no app credentials of its own (each user brings an API key), only the key that encrypts secrets at rest. */
export function coinbaseConfigured() {
  return Boolean(serverEnv.plaidTokenKey);
}
