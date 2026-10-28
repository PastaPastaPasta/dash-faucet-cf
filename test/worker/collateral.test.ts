import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/apikeys";
import { FakeChain } from "./fakechain";
import { RECIPIENT } from "../fixtures";

const chain = new FakeChain();
const COIN = 100_000_000;
const POOL = 20_000_000; // POOL_UTXO_SATS in vitest.config.ts

/** Txids a raw transaction spends. dashtx's own parser rejects valid 105-byte scriptSigs. */
function inputsOf(hex: string): string[] {
  const bytes = hex.match(/../g)!.map((b) => parseInt(b, 16));
  let at = 4; // 2-byte version + 2-byte type
  const varint = () => {
    const first = bytes[at++];
    if (first < 0xfd) return first;
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let value = 0;
    for (let i = 0; i < width; i++) value += bytes[at++] * 2 ** (8 * i);
    return value;
  };
  const count = varint();
  const txids: string[] = [];
  for (let i = 0; i < count; i++) {
    txids.push(bytes.slice(at, at + 32).reverse().map((b) => b.toString(16).padStart(2, "0")).join(""));
    at += 36;
    const scriptLength = varint();
    at += scriptLength + 4;
  }
  return txids;
}

let seq = 0;
function treasury() {
  seq += 1;
  return env.TREASURY.get(env.TREASURY.idFromName(`collateral-${seq}-${Math.random()}`));
}

/** Deep coins, so none of them needs a coinbase lookup. */
function coins(count: number, satoshis: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    txid: (offset + i + 1).toString(16).padStart(64, "0"),
    vout: 0,
    satoshis,
    height: 10,
  }));
}

beforeEach(() => {
  chain.height = 500;
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.install();
});

describe("collateral coin", () => {
  it("grows from small coins one bounded slice per pass, then funds an mn payout alone", async () => {
    chain.coins = [...coins(4, POOL), ...coins(60, 20 * COIN, 100)];
    const t = treasury();

    let passes = 0;
    for (;;) {
      const result = await t.maintain();
      if (result.action !== "consolidate") {
        expect(result.action).toBe("none");
        break;
      }
      passes += 1;
      expect(passes).toBeLessThan(30);
      // MAX_PAYOUT_INPUTS is 5: no pass may sign more than that.
      expect(inputsOf(chain.broadcastAttempts.at(-1)!.hex).length).toBeLessThanOrEqual(5);
    }
    expect(passes).toBeGreaterThan(1);
    expect((await t.snapshot()).collateralUtxos).toBe(1);

    const { token } = await t.createApiKey({ label: "mn-op", tier: "mn" });
    const before = chain.broadcastAttempts.length;
    const paid = await t.payout({
      address: RECIPIENT.testnet.address,
      pubKeyHash: RECIPIENT.testnet.pubKeyHash,
      ip: "203.0.113.70",
      apiKeyHash: hashApiKey(token),
    });
    expect(paid.ok && paid.satoshis).toBe(1000 * COIN);
    expect(inputsOf(chain.broadcastAttempts[before].hex)).toHaveLength(1);
  });

  it("leaves the pool coins it keeps for payouts alone", async () => {
    chain.coins = [...coins(4, POOL), ...coins(60, 20 * COIN, 100)];
    const t = treasury();
    await t.maintain();
    const poolTxids = new Set(coins(4, POOL).map((c) => c.txid));
    const spent = inputsOf(chain.broadcastAttempts.at(-1)!.hex);
    expect(spent).toHaveLength(5);
    const material = new Set(coins(60, 20 * COIN, 100).map((c) => c.txid));
    for (const txid of spent) {
      expect(poolTxids.has(txid)).toBe(false);
      expect(material.has(txid)).toBe(true);
    }
  });

  it("does nothing when the small coins could never reach a collateral", async () => {
    chain.coins = [...coins(4, POOL), ...coins(10, 20 * COIN, 100)];
    const result = await treasury().maintain();
    expect(result.action).toBe("none");
    expect(chain.broadcastAttempts).toHaveLength(0);
  });

  it("refills the pool from a small coin rather than splitting a collateral coin", async () => {
    const collateral = { txid: "c".repeat(64), vout: 0, satoshis: 1002 * COIN, height: 10 };
    chain.coins = [collateral, ...coins(1, 3 * COIN)];
    const result = await treasury().maintain();
    expect(result.action).toBe("split");
    expect(inputsOf(chain.broadcastAttempts.at(-1)!.hex)).not.toContain(collateral.txid);
  });

  it("keeps growing a pool-sized coin when the pool is at or under POOL_TARGET", async () => {
    // Regression: the coin being grown was itself counted as a kept pool coin
    // whenever there were few pool-size coins, so consolidation stalled.
    const grown = { txid: "9".repeat(64), vout: 0, satoshis: 990 * COIN, height: 10 };
    chain.coins = [...coins(3, POOL), grown, ...coins(100, 15_000_000, 200)];
    const t = treasury();
    const result = await t.maintain();
    expect(result.action).toBe("consolidate");
    expect(inputsOf(chain.broadcastAttempts.at(-1)!.hex)).toContain(grown.txid);
  });

  it("spends a collateral coin on an ordinary payout only when nothing else covers it", async () => {
    const collateral = { txid: "c".repeat(64), vout: 0, satoshis: 1002 * COIN, height: 10 };
    chain.coins = [collateral, ...coins(10, 20 * COIN)];
    const t = treasury();
    const { token } = await t.createApiKey({ label: "dcg", tier: "trusted" });
    const pay = (n: number, requestedSats: number) =>
      t.payout({
        address: `${RECIPIENT.testnet.address}-${n}`,
        pubKeyHash: RECIPIENT.testnet.pubKeyHash.slice(0, 38) + n.toString(16).padStart(2, "0"),
        ip: "203.0.113.71",
        apiKeyHash: hashApiKey(token),
        requestedSats,
      });

    expect((await pay(1, 50 * COIN)).ok).toBe(true);
    expect(inputsOf(chain.broadcastAttempts.at(-1)!.hex)).not.toContain(collateral.txid);

    // 500 tDASH: the small coins cannot cover it within the input cap.
    expect((await pay(2, 500 * COIN)).ok).toBe(true);
    expect(inputsOf(chain.broadcastAttempts.at(-1)!.hex)).toContain(collateral.txid);
  });
});
