import { describe, expect, it } from "vitest";
import { AddressError, addressToPubKeyHash, loadFaucetKey } from "../src/keys";
import { FAUCET, RECIPIENT } from "./fixtures";

describe("loadFaucetKey", () => {
  it("derives the expected testnet address", async () => {
    const key = await loadFaucetKey(FAUCET.testnet.wif, "testnet");
    expect(key.address).toBe(FAUCET.testnet.address);
    expect(key.pubKeyHash).toBe(FAUCET.testnet.pubKeyHash);
    expect(key.pubKeyBytes).toHaveLength(33); // compressed
  });

  it("derives the expected mainnet address", async () => {
    const key = await loadFaucetKey(FAUCET.mainnet.wif, "mainnet");
    expect(key.address).toBe(FAUCET.mainnet.address);
  });

  it("rejects a WIF from the wrong network", async () => {
    await expect(loadFaucetKey(FAUCET.testnet.wif, "mainnet")).rejects.toThrow(
      /not a valid mainnet WIF/,
    );
  });

  it("does not leak key material in the error", async () => {
    const err = await loadFaucetKey(FAUCET.mainnet.wif, "testnet").catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(FAUCET.mainnet.wif);
  });
});

describe("addressToPubKeyHash", () => {
  it("accepts a matching-network address", async () => {
    await expect(
      addressToPubKeyHash(RECIPIENT.testnet.address, "testnet"),
    ).resolves.toBe(RECIPIENT.testnet.pubKeyHash);
    await expect(
      addressToPubKeyHash(RECIPIENT.mainnet.address, "mainnet"),
    ).resolves.toBe(RECIPIENT.mainnet.pubKeyHash);
  });

  it("tolerates surrounding whitespace", async () => {
    await expect(
      addressToPubKeyHash(`  ${RECIPIENT.testnet.address}\n`, "testnet"),
    ).resolves.toBe(RECIPIENT.testnet.pubKeyHash);
  });

  // The old faucet only checked `len(address) < 26`, so a mainnet address
  // submitted to the testnet faucet produced an unspendable payout.
  it("rejects a mainnet address on testnet", async () => {
    await expect(
      addressToPubKeyHash(RECIPIENT.mainnet.address, "testnet"),
    ).rejects.toBeInstanceOf(AddressError);
  });

  it("rejects a testnet address on mainnet", async () => {
    await expect(
      addressToPubKeyHash(RECIPIENT.testnet.address, "mainnet"),
    ).rejects.toBeInstanceOf(AddressError);
  });

  it("rejects a corrupted checksum", async () => {
    const broken = RECIPIENT.testnet.address.slice(0, -1) + "X";
    await expect(addressToPubKeyHash(broken, "testnet")).rejects.toBeInstanceOf(
      AddressError,
    );
  });

  it("rejects a WIF submitted as an address", async () => {
    // decode() accepts same-network private keys, so type must be checked too.
    await expect(
      addressToPubKeyHash(FAUCET.testnet.wif, "testnet"),
    ).rejects.toThrow(/pay-to-public-key-hash/);
  });

  it("rejects an empty address", async () => {
    await expect(addressToPubKeyHash("   ", "testnet")).rejects.toThrow(
      /required/,
    );
  });
});
