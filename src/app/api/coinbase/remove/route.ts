import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/server/auth";

const Body = z.object({ connectionId: z.string().uuid() });

/**
 * Forgets the Coinbase API key. Accounts and transactions are kept. The key itself
 * can only be deleted in the Coinbase Developer Platform, which the UI points to.
 */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request");
  const { data, error } = await auth.supabase.from("coinbase_connections").delete().eq("id", parsed.data.connectionId).eq("user_id", auth.userId).select("id");
  if (error) return jsonError("Could not remove connection", 500);
  if (!data?.length) return jsonError("Connection not found", 404);
  return NextResponse.json({ ok: true });
}
