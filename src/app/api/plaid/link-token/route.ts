import { NextResponse } from "next/server";
import { CountryCode, Products, type LinkTokenCreateRequest } from "plaid";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/server/auth";
import { decryptSecret } from "@/lib/server/crypto";
import { plaidConfigured } from "@/lib/server/env";
import { plaid, plaidErrorMessage } from "@/lib/server/plaid";

const Body = z.object({ itemId: z.string().uuid().optional() });

function webhookUrl(request: Request): string | undefined {
  const base = process.env.APP_URL || new URL(request.url).origin;
  if (!base.startsWith("https://")) return undefined;
  const url = new URL("/api/plaid/webhook", base);
  // Lets Plaid reach the webhook when Vercel Deployment Protection is on.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) url.searchParams.set("x-vercel-protection-bypass", process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
  return url.toString();
}

/** Creates a Link token: a new connection, or "update mode" to re-authenticate an existing one. */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  if (!plaidConfigured()) return jsonError("Bank connections aren't configured on the server yet.", 503);
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Invalid request");

  const req: LinkTokenCreateRequest = {
    user: { client_user_id: auth.userId },
    client_name: "Ledger Finance",
    language: "en",
    country_codes: [CountryCode.Us],
    webhook: webhookUrl(request),
  };

  if (parsed.data.itemId) {
    const { data: item } = await auth.supabase.from("plaid_items").select("access_token_enc").eq("id", parsed.data.itemId).maybeSingle();
    if (!item) return jsonError("Connection not found", 404);
    req.access_token = decryptSecret(item.access_token_enc);
    // Update mode also collects consent for card statements on connections made before we asked for it.
    req.additional_consented_products = [Products.Liabilities];
  } else {
    req.products = [Products.Transactions];
    req.transactions = { days_requested: 730 };
    // Consent only: Liabilities is initialised (and billed) the first time a sync reads card statements.
    req.additional_consented_products = [Products.Liabilities];
  }

  try {
    const { data } = await plaid().linkTokenCreate(req);
    return NextResponse.json({ linkToken: data.link_token });
  } catch (err) {
    console.error("[plaid] link token", (err as Error).message);
    return jsonError(plaidErrorMessage(err), 502);
  }
}
