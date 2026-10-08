import "server-only";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Resolve the signed-in user for a route handler, with an RLS-scoped client: by default
 * scoped to the workspace the browser has open, or to all of the user's workspaces.
 */
export async function requireUser(scope: "current" | "all" = "current") {
  const supabase = await createSupabaseServerClient(scope);
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) } as const;
  return { supabase, userId } as const;
}

export const jsonError = (message: string, status = 400) => NextResponse.json({ error: message }, { status });
