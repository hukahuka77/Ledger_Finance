import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { WORKSPACE_COOKIE, WORKSPACE_HEADER } from "@/lib/workspace";

/**
 * Server-side Supabase client bound to the request's auth cookies.
 * `scope`: "current" works in the workspace the browser has open (its cookie);
 * "all" sees every workspace the user belongs to (e.g. bank sync, which may feed several).
 */
export async function createSupabaseServerClient(scope: "current" | "all" = "current") {
  const cookieStore = await cookies();
  const workspace = scope === "all" ? "all" : (cookieStore.get(WORKSPACE_COOKIE)?.value ?? "all");
  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { [WORKSPACE_HEADER]: workspace } },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component; the proxy refreshes the session instead.
        }
      },
    },
  });
}
