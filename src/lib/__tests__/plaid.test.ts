import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { mapAccountType, mapTransactionType, pickCategory, suggestAccountMatch, toLedgerAmount } from "@/lib/plaid/mapping";

vi.mock("server-only", () => ({}));
const keys: Record<string, unknown> = {};
vi.mock("@/lib/server/plaid", () => ({
  plaid: () => ({ webhookVerificationKeyGet: async ({ key_id }: { key_id: string }) => ({ data: { key: keys[key_id] } }) }),
}));

describe("plaid mapping", () => {
  it("flips Plaid's sign convention", () => {
    expect(toLedgerAmount(29.56)).toBe(-29.56);
    expect(toLedgerAmount(-2500)).toBe(2500);
  });

  it("maps account types", () => {
    expect(mapAccountType("credit", "credit card")).toBe("credit_card");
    expect(mapAccountType("depository", "savings")).toBe("savings");
    expect(mapAccountType("depository", "checking")).toBe("checking");
    expect(mapAccountType("loan", "mortgage")).toBe("mortgage");
    expect(mapAccountType("loan", "student")).toBe("loan");
    expect(mapAccountType("investment", "roth")).toBe("retirement");
    expect(mapAccountType("investment", "brokerage")).toBe("brokerage");
  });

  it("keeps transfers and card payments out of spending", () => {
    const pfc = (primary: string, detailed = primary) => ({ primary, detailed });
    expect(mapTransactionType({ amount: -1230, personal_finance_category: pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") }, "credit_card")).toBe(
      "credit_card_payment",
    );
    expect(mapTransactionType({ amount: 1230, personal_finance_category: pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") }, "checking")).toBe(
      "credit_card_payment",
    );
    expect(mapTransactionType({ amount: 500, personal_finance_category: pfc("TRANSFER_OUT") }, "checking")).toBe("transfer");
    expect(mapTransactionType({ amount: -3000, personal_finance_category: pfc("INCOME", "INCOME_WAGES") }, "checking")).toBe("income");
    expect(mapTransactionType({ amount: 29.56, personal_finance_category: pfc("FOOD_AND_DRINK") }, "credit_card")).toBe("expense");
    expect(mapTransactionType({ amount: -15, personal_finance_category: pfc("GENERAL_MERCHANDISE") }, "credit_card")).toBe("refund");
  });

  it("maps Plaid categories onto the user's own names", () => {
    const byName = new Map([
      ["quick eats (solo)", "qe"],
      ["restaurants", "r"],
      ["gambling", "g"],
    ]);
    expect(pickCategory({ primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_FAST_FOOD" }, byName)).toBe("qe");
    expect(pickCategory({ primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_OTHER" }, byName)).toBe("r");
    expect(pickCategory({ primary: "ENTERTAINMENT", detailed: "ENTERTAINMENT_CASINOS_AND_GAMBLING" }, byName)).toBe("g");
    expect(pickCategory({ primary: "MEDICAL", detailed: "MEDICAL_OTHER" }, byName)).toBeNull();
  });

  it("suggests the matching ledger account by mask", () => {
    const accounts = [
      { id: "a", name: "Robinhood Credit Card", last_four: "9929" },
      { id: "b", name: "WF Checkings", last_four: "0855" },
      { id: "c", name: "Student loan 1", last_four: "4064" },
      { id: "d", name: "Student loan 2", last_four: "4064" },
    ];
    expect(suggestAccountMatch({ account_id: "x", name: "Everyday Checking", mask: "0855", type: "depository" }, accounts)?.id).toBe("b");
    expect(suggestAccountMatch({ account_id: "x", name: "Student loan 2", mask: "4064", type: "loan" }, accounts)?.id).toBe("d");
    expect(suggestAccountMatch({ account_id: "x", name: "Mystery", mask: "0000", type: "credit" }, accounts)).toBeUndefined();
  });
});

describe("plaid webhook verification", () => {
  it("accepts a correctly signed body and rejects tampering", async () => {
    const { verifyPlaidWebhook } = await import("@/lib/server/plaid-webhook");
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    keys["k1"] = { ...(await exportJWK(publicKey)), alg: "ES256", kid: "k1", use: "sig", created_at: 0, expired_at: null };
    const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "i" });
    const token = await new SignJWT({ request_body_sha256: createHash("sha256").update(body).digest("hex") })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuedAt()
      .sign(privateKey);
    expect(await verifyPlaidWebhook(body, token)).toBe(true);
    expect(await verifyPlaidWebhook(body.replace("SYNC", "XSYNC"), token)).toBe(false);
    expect(await verifyPlaidWebhook(body, null)).toBe(false);
    expect(await verifyPlaidWebhook(body, "not-a-jwt")).toBe(false);
  });
});
