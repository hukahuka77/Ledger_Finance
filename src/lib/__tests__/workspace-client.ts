/**
 * Test helper: sign in to the local stack and get a client working in the user's first
 * workspace (as the app does, via the x-workspace-id header).
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

export async function signInToWorkspace(url: string, email: string, password: string) {
  const base = createClient<Database>(url, "local-anon", { auth: { persistSession: false } });
  const { data, error } = await base.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { data: ws, error: wsErr } = await base.rpc("ensure_personal_workspace", {});
  if (wsErr) throw wsErr;
  const workspaceId = ws as string;
  const db = createClient<Database>(url, "local-anon", { auth: { persistSession: false }, global: { headers: { "x-workspace-id": workspaceId } } });
  await db.auth.setSession({ access_token: data.session!.access_token, refresh_token: data.session!.refresh_token });
  return { db, userId: data.user!.id, workspaceId };
}
