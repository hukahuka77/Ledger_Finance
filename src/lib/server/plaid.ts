import "server-only";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { serverEnv } from "@/lib/server/env";

let client: PlaidApi | undefined;

export function plaid(): PlaidApi {
  if (!client) {
    client = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[serverEnv.plaidEnv] ?? PlaidEnvironments.sandbox,
        baseOptions: {
          headers: { "PLAID-CLIENT-ID": serverEnv.plaidClientId, "PLAID-SECRET": serverEnv.plaidSecret, "Plaid-Version": "2020-09-14" },
        },
      }),
    );
  }
  return client;
}

/** Plaid API errors carry a machine-readable code in the response body. */
export function plaidErrorCode(err: unknown): string | undefined {
  const e = err as { response?: { data?: { error_code?: string } } };
  return e?.response?.data?.error_code;
}

export function plaidErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error_message?: string; display_message?: string | null } }; message?: string };
  return e?.response?.data?.display_message || e?.response?.data?.error_message || e?.message || "Plaid request failed";
}
