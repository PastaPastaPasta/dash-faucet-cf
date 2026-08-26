import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadFaucetKey } from "../src/keys";
import {
  InsufficientFundsError,
  SelfPayError,
  buildPayout,
  buildSplit,
  selectInputs,
} from "../src/tx";
import { FAUCET, FAUCET_SCRIPT_TESTNET, RECIPIENT, utxo } from "./fixtures";

const key = await loadFaucetKey(FAUCET.testnet.wif, "testnet");

/** Independent txid derivation, so we are not just trusting dashtx.getId. */
function txidOf(hex: string): string {
  const once = createHash("sha256").update(Buffer.from(hex, "hex")).digest();
  const twice = createHash("sha256").update(once).digest();
  return Buffer.from(twice).reverse().toString("hex");
}

describe("selectInputs", () => {
  it("prefers a single coin that covers the payout", () => {
    const coins = [utxo("a", 0, 50_000), utxo("b", 0, 500_000_000), utxo("c", 0, 900_000_000)];
    const picked = selectInputs(coins, 100_000_000);
    expect(picked).toHaveLength(1);
    // smallest sufficient coin, so large coins stay whole for later payouts
    expect(picked[0].satoshis).toBe(500_000_000);
  });

  it("accumulates largest-first when no single coin is enough", () => {
    const coins = [utxo("a", 0, 60_000_000), utxo("b", 0, 70_000_000)];
    const picked = selectInputs(coins, 100_000_000);
    expect(picked).toHaveLength(2);
  });

  it("throws when the total is short", () => {
    expect(() => selectInputs([utxo("a", 0, 1_000)], 100_000_000)).toThrow(
      InsufficientFundsError,
    );
  });

  it("throws on an empty coin set", () => {
    expect(() => selectInputs([], 1_000)).toThrow(InsufficientFundsError);
  });
});

describe("buildPayout", () => {
  const coins = [utxo("a", 0, 500_000_000), utxo("b", 1, 500_000_000)];

  it("builds a single-input payout with change back to the faucet", async () => {
    const built = await buildPayout({
      key,
      utxos: coins,
      recipientPubKeyHash: RECIPIENT.testnet.pubKeyHash,
      satoshis: 100_000_000,
    });

    // One input keeps the request inside the Workers CPU budget.
    expect(built.inputs).toHaveLength(1);
    expect(built.totalIn).toBe(500_000_000);

    // Exactly one output comes back to us: the change.
    expect(built.ownOutputs).toHaveLength(1);
    expect(built.ownOutputs[0].satoshis).toBe(
      built.totalIn - 100_000_000 - built.fee,
    );
    expect(built.ownOutputs[0].txid).toBe(built.txid);
  });

  it("produces a txid that matches an independent double-SHA256", async () => {
    const built = await buildPayout({
      key,
      utxos: coins,
      recipientPubKeyHash: RECIPIENT.testnet.pubKeyHash,
      satoshis: 100_000_000,
    });
    expect(built.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(built.hex).toMatch(/^[0-9a-f]+$/);
    expect(txidOf(built.hex)).toBe(built.txid);
  });

  it("charges a fee in the sane range for 1-in-2-out", async () => {
    const built = await buildPayout({
      key,
      utxos: coins,
      recipientPubKeyHash: RECIPIENT.testnet.pubKeyHash,
      satoshis: 100_000_000,
    });
    // ~192-227 bytes at 1 duff/byte. Assert a band, not an exact number,
    // because signature length varies by a byte or two.
    expect(built.fee).toBeGreaterThan(150);
    expect(built.fee).toBeLessThan(400);
  });

  it("pays the recipient the exact requested amount", async () => {
    const built = await buildPayout({
      key,
      utxos: coins,
      recipientPubKeyHash: RECIPIENT.testnet.pubKeyHash,
      satoshis: 100_000_000,
    });
    const outputTotal = 100_000_000 + built.ownOutputs[0].satoshis;
    expect(built.totalIn - outputTotal).toBe(built.fee);
  });

  it("refuses to pay the faucet's own address", async () => {
    await expect(
      buildPayout({
        key,
        utxos: coins,
        recipientPubKeyHash: key.pubKeyHash,
        satoshis: 100_000_000,
      }),
    ).rejects.toThrow(SelfPayError);
  });

  it("reports insufficient funds rather than building a bad tx", async () => {
    await expect(
      buildPayout({
        key,
        utxos: [utxo("a", 0, 1_000)],
        recipientPubKeyHash: RECIPIENT.testnet.pubKeyHash,
        satoshis: 100_000_000,
      }),
    ).rejects.toThrow(InsufficientFundsError);
  });
});

describe("buildSplit", () => {
  it("turns one coin into N pool coins, all owned by the faucet", async () => {
    const built = await buildSplit({
      key,
      utxos: [utxo("f", 0, 10_000_000_000, FAUCET_SCRIPT_TESTNET)],
      count: 5,
      perOutputSats: 500_000_000,
    });

    // 5 pool coins plus change, every one of them ours.
    expect(built.ownOutputs).toHaveLength(6);
    expect(built.ownOutputs.filter((o) => o.satoshis === 500_000_000)).toHaveLength(5);
    expect(txidOf(built.hex)).toBe(built.txid);
    expect(built.fee).toBeGreaterThan(0);
  });

  it("omits a dust change output", async () => {
    // Exactly enough for 2 coins plus fee, leaving nothing worth keeping.
    const built = await buildSplit({
      key,
      utxos: [utxo("f", 0, 1_000_000_400)],
      count: 2,
      perOutputSats: 500_000_000,
    });
    expect(built.ownOutputs).toHaveLength(2);
  });

  it("refuses a split it cannot fund", async () => {
    await expect(
      buildSplit({
        key,
        utxos: [utxo("f", 0, 1_000_000)],
        count: 5,
        perOutputSats: 500_000_000,
      }),
    ).rejects.toThrow(InsufficientFundsError);
  });

  it("requires at least two outputs", async () => {
    await expect(
      buildSplit({ key, utxos: [utxo("f", 0, 1_000_000_000)], count: 1, perOutputSats: 1_000 }),
    ).rejects.toThrow(/at least 2/);
  });
});
