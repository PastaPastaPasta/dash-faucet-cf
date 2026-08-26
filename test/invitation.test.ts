import { describe, expect, it } from "vitest";
import {
  decryptWif,
  encryptWif,
  invitationUri,
  prospectiveIdentityId,
} from "../src/invitation";

describe("invitation secrets", () => {
  it("round-trips a WIF with authenticated encryption", async () => {
    const encrypted = await encryptWif("not-a-real-wif", "test-secret");
    expect(encrypted.cipherHex).not.toContain("not-a-real-wif");
    await expect(decryptWif(encrypted, "test-secret")).resolves.toBe("not-a-real-wif");
    await expect(decryptWif(encrypted, "wrong-secret")).rejects.toThrow();
  });

  it("emits the released-wallet-compatible ChainLock link", () => {
    const uri = invitationUri("ab".repeat(32), "cVoucherWif");
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("dashpay:");
    expect(parsed.hostname).toBe("invite");
    expect(parsed.searchParams.has("du")).toBe(false);
    expect(parsed.searchParams.get("assetlocktx")).toBe("ab".repeat(32));
    expect(parsed.searchParams.get("pk")).toBe("cVoucherWif");
    expect(parsed.searchParams.get("islock")).toBe("null");
  });

  it("derives the identity ID from canonical outpoint bytes", () => {
    // Vector uses the txid from rs-dpp's ChainAssetLockProof tests, vout 1.
    expect(
      prospectiveIdentityId(
        "e8b43025641eea4fd21190f01bd870ef90f1a8b199d8fc3376c5b62c0b1a179d",
        1,
      ),
    ).toBe("BKCad5uXKagQLvFJqVZ9tWqkNjKK2Wq3nndcdJtmSvXk");
  });
});
