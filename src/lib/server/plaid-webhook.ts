import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { plaid } from "@/lib/server/plaid";

const keyCache = new Map<string, { jwk: JWK; fetchedAt: number }>();

/**
 * Verifies Plaid's `Plaid-Verification` JWT (ES256) and that it signs this exact body.
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 */
export async function verifyPlaidWebhook(rawBody: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "ES256" || !header.kid) return false;
    let cached = keyCache.get(header.kid);
    if (!cached || Date.now() - cached.fetchedAt > 24 * 3600_000) {
      const { data } = await plaid().webhookVerificationKeyGet({ key_id: header.kid });
      if (data.key.expired_at) return false;
      cached = { jwk: data.key as unknown as JWK, fetchedAt: Date.now() };
      keyCache.set(header.kid, cached);
    }
    const key = await importJWK(cached.jwk, "ES256");
    const { payload } = await jwtVerify(token, key, { algorithms: ["ES256"], maxTokenAge: "5 min" });
    const claimed = String((payload as { request_body_sha256?: string }).request_body_sha256 ?? "");
    const actual = createHash("sha256").update(rawBody, "utf8").digest("hex");
    return claimed.length === actual.length && timingSafeEqual(Buffer.from(claimed), Buffer.from(actual));
  } catch (err) {
    console.warn("[plaid] webhook verification failed", (err as Error).message);
    return false;
  }
}
