import "server-only";
import { createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import type { CbAccount, CbTransaction } from "@/lib/coinbase/mapping";

/**
 * Minimal read-only client for the Coinbase App API (v2) using a CDP secret API key.
 * Coinbase App endpoints only accept ECDSA (ES256) keys; each request carries a
 * short-lived JWT bound to its method, host and path.
 */

const HOST = "api.coinbase.com";

export class CoinbaseError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: "auth" | "key_format" | "other" = "other",
  ) {
    super(message);
  }
}

export interface CoinbaseCredentials {
  keyName: string;
  privateKey: string;
}

/** Normalise what people paste: quoted JSON strings, literal "\n" escapes, Windows newlines. */
export function normalisePrivateKey(raw: string): string {
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

export function parsePrivateKey(raw: string): KeyObject {
  const pem = normalisePrivateKey(raw);
  if (!pem.includes("-----BEGIN")) {
    throw new CoinbaseError(
      "That private key isn't in the ECDSA format Coinbase needs. Create a new key with the signature algorithm set to ECDSA (not Ed25519).",
      null,
      "key_format",
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new CoinbaseError("Couldn't read that private key. Paste the whole value, including the BEGIN and END lines.", null, "key_format");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new CoinbaseError("Coinbase needs an ECDSA (P-256) key. Create a new key with the signature algorithm set to ECDSA.", null, "key_format");
  }
  return key;
}

/** JWT for one request. `path` excludes the query string. */
export async function buildJwt(creds: CoinbaseCredentials, method: string, path: string, key = parsePrivateKey(creds.privateKey)): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ uri: `${method} ${HOST}${path}` })
    .setProtectedHeader({ alg: "ES256", kid: creds.keyName, typ: "JWT", nonce: randomBytes(16).toString("hex") })
    .setIssuer("cdp")
    .setSubject(creds.keyName)
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(key);
}

interface Page<T> {
  data: T[];
  pagination?: { next_uri?: string | null } | null;
}

export class CoinbaseClient {
  private readonly key: KeyObject;

  constructor(
    private readonly creds: CoinbaseCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = parsePrivateKey(creds.privateKey);
  }

  /** GET a path (may include a query string) and return the parsed body. */
  async get<T>(pathWithQuery: string): Promise<T> {
    const path = pathWithQuery.split("?")[0];
    const jwt = await buildJwt(this.creds, "GET", path, this.key);
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`https://${HOST}${pathWithQuery}`, {
        headers: { authorization: `Bearer ${jwt}`, accept: "application/json", "CB-VERSION": "2024-06-01" },
        cache: "no-store",
      });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new CoinbaseError(
          "Coinbase rejected the API key. Check that it's an ECDSA key with View permission and that it hasn't been deleted.",
          res.status,
          "auth",
        );
      }
      throw new CoinbaseError(`Coinbase returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`, res.status);
    }
  }

  /** Follow `pagination.next_uri` until exhausted, `stop` says so, or `maxPages` is hit. */
  async paginate<T>(firstPath: string, opts: { maxPages?: number; stop?: (page: T[]) => boolean } = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | null | undefined = firstPath;
    for (let i = 0; next && i < (opts.maxPages ?? 100); i++) {
      const page: Page<T> = await this.get<Page<T>>(next);
      out.push(...page.data);
      if (opts.stop?.(page.data)) break;
      next = page.pagination?.next_uri;
    }
    return out;
  }

  accounts() {
    return this.paginate<CbAccount>("/v2/accounts?limit=250");
  }

  transactions(accountId: string, stop?: (page: CbTransaction[]) => boolean) {
    return this.paginate<CbTransaction>(`/v2/accounts/${encodeURIComponent(accountId)}/transactions?limit=100&order=desc`, { stop, maxPages: 200 });
  }

  /** Units of each currency per 1 USD (public endpoint). */
  async usdRates(): Promise<Record<string, string>> {
    const res = await this.fetchImpl(`https://${HOST}/v2/exchange-rates?currency=USD`, { cache: "no-store" });
    if (!res.ok) throw new CoinbaseError(`Coinbase exchange rates returned ${res.status}`, res.status);
    const body = (await res.json()) as { data: { rates: Record<string, string> } };
    return body.data.rates;
  }
}
