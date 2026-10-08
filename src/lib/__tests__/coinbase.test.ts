import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { mapCoinbaseTransaction, toUsd, totalUsd, walletUsd, type CbTransaction } from "@/lib/coinbase/mapping";

vi.mock("server-only", () => ({}));

const rates = { BTC: "0.00001", ETH: "0.0004", USDC: "1" };
const tx = (o: Partial<CbTransaction> & Pick<CbTransaction, "type" | "amount">): CbTransaction => ({
  id: "t1",
  status: "completed",
  created_at: "2026-09-14T18:22:05Z",
  ...o,
});

describe("coinbase mapping", () => {
  it("values balances in USD from rates or native balance", () => {
    expect(toUsd(0.5, "BTC", rates)).toBeCloseTo(50_000);
    expect(toUsd(12, "USD", rates)).toBe(12);
    expect(toUsd(1, "DOGE", rates)).toBeNull();
    expect(walletUsd({ id: "w", name: "BTC Wallet", currency: { code: "BTC" }, balance: { amount: "0.01", currency: "BTC" } }, rates)).toBeCloseTo(1000);
    expect(
      walletUsd(
        { id: "w", name: "ETH", currency: "ETH", balance: { amount: "1", currency: "ETH" }, native_balance: { amount: "2600.12", currency: "USD" } },
        rates,
      ),
    ).toBe(2600.12);
    expect(totalUsd([{ usd: 10.004 }, { usd: null }, { usd: 5.5 }])).toBe(15.5);
  });

  it("maps a buy as a transfer into the wallet, priced by native_amount", () => {
    const m = mapCoinbaseTransaction(
      tx({ type: "buy", amount: { amount: "0.00150000", currency: "BTC" }, native_amount: { amount: "150.00", currency: "USD" } }),
      "BTC",
      rates,
    )!;
    expect(m).toMatchObject({
      coinbase_transaction_id: "t1",
      transaction_date: "2026-09-14",
      posted_date: "2026-09-14",
      status: "posted",
      amount: 150,
      merchant_name: "Buy BTC",
      transaction_type: "transfer",
    });
    expect(m.original_description).toBe("buy · 0.0015 BTC");
  });

  it("labels sends by direction", () => {
    expect(mapCoinbaseTransaction(tx({ type: "send", amount: { amount: "-0.1", currency: "ETH" } }), "ETH", rates)!).toMatchObject({
      merchant_name: "Sent ETH",
      amount: -250,
      transaction_type: "transfer",
    });
    expect(mapCoinbaseTransaction(tx({ type: "send", amount: { amount: "0.1", currency: "ETH" } }), "ETH", rates)!.merchant_name).toBe("Received ETH");
  });

  it("treats rewards as income and card spending as expenses or refunds", () => {
    expect(
      mapCoinbaseTransaction(
        tx({ type: "staking_reward", amount: { amount: "0.01", currency: "ETH" }, native_amount: { amount: "25.10", currency: "USD" } }),
        "ETH",
        rates,
      )!,
    ).toMatchObject({ transaction_type: "income", merchant_name: "ETH staking reward", amount: 25.1 });
    expect(
      mapCoinbaseTransaction(
        tx({
          type: "card_spend",
          amount: { amount: "-12.5", currency: "USDC" },
          native_amount: { amount: "-12.50", currency: "USD" },
          details: { title: "Blue Bottle Coffee" },
        }),
        "USDC",
        rates,
      )!,
    ).toMatchObject({ transaction_type: "expense", merchant_name: "Blue Bottle Coffee", amount: -12.5 });
    expect(
      mapCoinbaseTransaction(
        tx({ type: "card_spend", amount: { amount: "4", currency: "USDC" }, native_amount: { amount: "4.00", currency: "USD" } }),
        "USDC",
        rates,
      )!,
    ).toMatchObject({ transaction_type: "refund", merchant_name: "Coinbase Card purchase" });
  });

  it("keeps pending, skips failed, canceled and dust", () => {
    expect(mapCoinbaseTransaction(tx({ type: "send", status: "pending", amount: { amount: "-1", currency: "USDC" } }), "USDC", rates)).toMatchObject({
      status: "pending",
      posted_date: null,
    });
    expect(mapCoinbaseTransaction(tx({ type: "send", status: "failed", amount: { amount: "-1", currency: "USDC" } }), "USDC", rates)).toBeNull();
    expect(mapCoinbaseTransaction(tx({ type: "send", status: "canceled", amount: { amount: "-1", currency: "USDC" } }), "USDC", rates)).toBeNull();
    expect(mapCoinbaseTransaction(tx({ type: "interest", amount: { amount: "0.000001", currency: "USDC" } }), "USDC", rates)).toBeNull();
    expect(mapCoinbaseTransaction(tx({ type: "buy", amount: { amount: "5", currency: "DOGE" } }), "DOGE", rates)).toBeNull();
  });

  it("names unknown types readably", () => {
    expect(mapCoinbaseTransaction(tx({ type: "vault_withdrawal", amount: { amount: "1", currency: "USDC" } }), "USDC", rates)!.merchant_name).toBe(
      "Vault withdrawal USDC",
    );
  });
});

describe("coinbase client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const keyName = "organizations/org-1/apiKeys/key-1";

  it("signs an ES256 JWT bound to the request path, without the query", async () => {
    const { CoinbaseClient } = await import("@/lib/server/coinbase");
    const seen: { url: string; auth: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ data: [{ id: "a" }], pagination: { next_uri: null } }), { status: 200 });
    }) as unknown as typeof fetch;
    // Pasted with literal "\n" escapes, as it appears in Coinbase's JSON download.
    const client = new CoinbaseClient({ keyName, privateKey: pem.replace(/\n/g, "\\n") }, fetchImpl);
    const rows = await client.accounts();
    expect(rows).toEqual([{ id: "a" }]);
    expect(seen[0].url).toBe("https://api.coinbase.com/v2/accounts?limit=250");
    const jwt = seen[0].auth.replace(/^Bearer /, "");
    const header = decodeProtectedHeader(jwt);
    expect(header).toMatchObject({ alg: "ES256", kid: keyName, typ: "JWT" });
    expect(typeof header.nonce).toBe("string");
    const { payload } = await jwtVerify(jwt, publicKey, { issuer: "cdp", subject: keyName });
    expect(payload.uri).toBe("GET api.coinbase.com/v2/accounts");
    expect(payload.exp! - payload.nbf!).toBe(120);
  });

  it("follows next_uri pagination and stops early when asked", async () => {
    const { CoinbaseClient } = await import("@/lib/server/coinbase");
    const pages: Record<string, unknown> = {
      "/v2/accounts/w1/transactions?limit=100&order=desc": {
        data: [{ id: "1" }, { id: "2" }],
        pagination: { next_uri: "/v2/accounts/w1/transactions?starting_after=2" },
      },
      "/v2/accounts/w1/transactions?starting_after=2": { data: [{ id: "3" }], pagination: { next_uri: "/v2/accounts/w1/transactions?starting_after=3" } },
    };
    const fetchImpl = (async (url: string) => {
      const body = pages[url.replace("https://api.coinbase.com", "")];
      return body ? new Response(JSON.stringify(body)) : new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const client = new CoinbaseClient({ keyName, privateKey: pem }, fetchImpl);
    const all = await client.transactions("w1", (page) => page.some((t) => t.id === "3"));
    expect(all.map((t) => t.id)).toEqual(["1", "2", "3"]);
    const first = await client.transactions("w1", (page) => page.some((t) => t.id === "1"));
    expect(first.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("explains rejected and wrong-format keys", async () => {
    const { CoinbaseClient } = await import("@/lib/server/coinbase");
    const unauthorized = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(new CoinbaseClient({ keyName, privateKey: pem }, unauthorized).accounts()).rejects.toMatchObject({ kind: "auth" });
    // An Ed25519 secret is a bare base64 string, not a PEM.
    expect(() => new CoinbaseClient({ keyName, privateKey: Buffer.alloc(64, 1).toString("base64") })).toThrow(/ECDSA/);
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => new CoinbaseClient({ keyName, privateKey: ed })).toThrow(/ECDSA/);
  });
});
