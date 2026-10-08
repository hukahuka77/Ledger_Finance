import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";
import { getCurrentWorkspaceId, WORKSPACE_HEADER } from "@/lib/workspace";

let client: ReturnType<typeof createBrowserClient<Database>> | undefined;

/** Adds the current workspace to every request unless the caller set one. */
const workspaceFetch: typeof fetch = (input, init) => {
  const id = getCurrentWorkspaceId();
  if (!id) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has(WORKSPACE_HEADER)) headers.set(WORKSPACE_HEADER, id);
  return fetch(input, { ...init, headers });
};

/**
 * Browser Supabase client (publishable key + the user's session cookie). RLS scopes every
 * query to the signed-in user's current workspace (see lib/workspace).
 */
export function getSupabase() {
  if (!client) {
    client = createBrowserClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      global: { fetch: workspaceFetch },
    });
  }
  return client;
}

export type SupabaseClient = ReturnType<typeof getSupabase>;
