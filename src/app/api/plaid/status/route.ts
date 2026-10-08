import { NextResponse } from "next/server";
import { backgroundSyncConfigured, coinbaseConfigured, plaidConfigured, serverEnv } from "@/lib/server/env";
import { requireUser } from "@/lib/server/auth";

export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  return NextResponse.json({
    configured: plaidConfigured(),
    backgroundSync: backgroundSyncConfigured(),
    environment: serverEnv.plaidEnv,
    coinbase: coinbaseConfigured(),
  });
}
