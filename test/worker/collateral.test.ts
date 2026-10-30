import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/apikeys";
import { FakeChain, parseTx } from "./fakechain";
import { FAUCET_SCRIPT_TESTNET, RECIPIENT } from "../fixtures";

const chain = new FakeChain();
const COIN = 100_000_000;
const POOL = 20_000_000; // POOL_UTXO_SATS in vitest.config.ts

/** Txids a raw transaction spends. */
function inputsOf(hex: string): string[] {
  return parseTx(hex).inputs.map((i) => i.txid);
}

/** Mine the most recent broadcast. */
function mineLast(): Promise<void> {
  return chain.confirm(chain.lastBroadcast, FAUCET_SCRIPT_TESTNET);
}

function bookedAlarm(t: ReturnType<typeof treasury>): Promise<number | null> {
  return runInDurableObject(t, (_, state) => state.storage.getAlarm());
}

/**
 * Run the follow-up a test just booked. Booked alarms are real timers a few
 * seconds out, so on a slow machine it may have fired already; either way it
 * has run once this returns.
 */
async function followUp(t: ReturnType<typeof treasury>): Promise<void> {
  await runDurableObjectAlarm(t);
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
  it("grows from small coins one bounded slice per block, then funds an mn payout alone", async () => {
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
      expect(inputsOf(chain.lastBroadcast).length).toBeLessThanOrEqual(5);
      // A merge spends confirmed coins only, so the next one needs a block.
      // Each pass also books a follow-up; this loop is the follow-up here.
      await mineLast();
      await runInDurableObject(t, (_, state) => state.storage.deleteAlarm());
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
    const spent = inputsOf(chain.lastBroadcast);
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
    expect(inputsOf(chain.lastBroadcast)).not.toContain(collateral.txid);
  });

  it("keeps growing a pool-sized coin when the pool is at or under POOL_TARGET", async () => {
    // Regression: the coin being grown was itself counted as a kept pool coin
    // whenever there were few pool-size coins, so consolidation stalled.
    const grown = { txid: "9".repeat(64), vout: 0, satoshis: 990 * COIN, height: 10 };
    chain.coins = [...coins(3, POOL), grown, ...coins(100, 15_000_000, 200)];
    const t = treasury();
    const result = await t.maintain();
    expect(result.action).toBe("consolidate");
    expect(inputsOf(chain.lastBroadcast)).toContain(grown.txid);
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
    expect(inputsOf(chain.lastBroadcast)).not.toContain(collateral.txid);

    // 500 tDASH: the small coins cannot cover it within the input cap.
    expect((await pay(2, 500 * COIN)).ok).toBe(true);
    expect(inputsOf(chain.lastBroadcast)).toContain(collateral.txid);
  });
});

describe("real-time merging", () => {
  async function keyFor(t: ReturnType<typeof treasury>, tier: "mn" | "trusted") {
    const { token } = await t.createApiKey({ label: tier, tier });
    return hashApiKey(token);
  }
  const to = (n: number) => ({
    address: `${RECIPIENT.testnet.address}-${n}`,
    pubKeyHash: RECIPIENT.testnet.pubKeyHash.slice(0, 38) + n.toString(16).padStart(2, "0"),
    ip: "203.0.113.80",
  });

  it("pays an mn key from many confirmed coins when no collateral coin exists", async () => {
    chain.coins = [...coins(4, POOL), ...coins(5, 210 * COIN, 100)];
    const t = treasury();
    const paid = await t.payout({ ...to(1), apiKeyHash: await keyFor(t, "mn") });
    expect(paid.ok && paid.satoshis).toBe(1000 * COIN);

    const tx = parseTx(chain.lastBroadcast);
    expect(tx.inputs).toHaveLength(5);
    // Still exactly one 1000 DASH output: the collateral.
    expect(tx.outputs.filter((o) => o.satoshis === 1000 * COIN)).toHaveLength(1);
  });

  it("rebuilds the collateral coin right after a payout spends it", async () => {
    const collateral = { txid: "c".repeat(64), vout: 0, satoshis: 1002 * COIN, height: 10 };
    chain.coins = [collateral, ...coins(4, POOL), ...coins(5, 250 * COIN, 100)];
    const t = treasury();
    const paid = await t.payout({ ...to(2), apiKeyHash: await keyFor(t, "mn") });
    expect(paid.ok).toBe(true);
    expect(inputsOf(chain.lastBroadcast)).toEqual([collateral.txid]);
    expect((await t.snapshot()).collateralUtxos).toBe(0);

    // Booked within seconds, not at the next cron.
    const booked = await bookedAlarm(t);
    expect(booked).not.toBeNull();
    expect(booked! - Date.now()).toBeLessThan(10_000);

    await followUp(t);
    const merge = parseTx(chain.lastBroadcast);
    expect(merge.inputs).toHaveLength(5);
    const pool = new Set(coins(4, POOL).map((c) => c.txid));
    expect(merge.inputs.some((i) => pool.has(i.txid))).toBe(false);
    expect((await t.snapshot()).collateralUtxos).toBe(1);
  });

  it("answers fragmented while coins confirm, then merges them as soon as they do", async () => {
    chain.coins = [...coins(4, POOL), ...coins(2, 600 * COIN, 100)];
    const t = treasury();

    // Leaves 600 confirmed and ~500 of unconfirmed change.
    const trusted = await t.payout({ ...to(3), apiKeyHash: await keyFor(t, "trusted"), requestedSats: 100 * COIN });
    expect(trusted.ok).toBe(true);
    const payoutHex = chain.lastBroadcast;

    const mn = await keyFor(t, "mn");
    const early = await t.payout({ ...to(4), apiKeyHash: mn });
    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.code).toBe("fragmented");
    expect("retryAfter" in early && early.retryAfter).toBeGreaterThan(0);
    // Unconfirmed change is never one of several inputs.
    expect(chain.lastBroadcast).toBe(payoutHex);

    // Nothing to merge yet: it looks again in a minute rather than giving up.
    await followUp(t);
    expect(chain.lastBroadcast).toBe(payoutHex);
    const again = await bookedAlarm(t);
    expect(again! - Date.now()).toBeGreaterThan(30_000);

    // The block lands: the next look merges, and the mn payout is one input.
    await chain.confirm(payoutHex, FAUCET_SCRIPT_TESTNET);
    // The one-minute look, run now rather than waited for.
    expect(await runDurableObjectAlarm(t)).toBe(true);
    expect(inputsOf(chain.lastBroadcast)).toHaveLength(2);
    expect((await t.snapshot()).collateralUtxos).toBe(1);

    const paid = await t.payout({ ...to(4), apiKeyHash: mn });
    expect(paid.ok && paid.satoshis).toBe(1000 * COIN);
    expect(inputsOf(chain.lastBroadcast)).toHaveLength(1);
  });

  it("merges toward a large trusted amount that needs more coins than one transaction", async () => {
    const collateral = { txid: "c".repeat(64), vout: 0, satoshis: 1002 * COIN, height: 10 };
    chain.coins = [collateral, ...coins(4, POOL), ...coins(12, 150 * COIN, 100)];
    const t = treasury();
    const trusted = await keyFor(t, "trusted");

    // 1700 tDASH takes 12 coins; MAX_PAYOUT_INPUTS is 5.
    const early = await t.payout({ ...to(6), apiKeyHash: trusted, requestedSats: 1700 * COIN });
    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.code).toBe("fragmented");
    expect(chain.broadcastAttempts).toHaveLength(0);

    // Five coins cannot reach it: merge the largest, then finish a block later.
    await followUp(t);
    expect(inputsOf(chain.lastBroadcast)).toHaveLength(5);
    await mineLast();
    expect((await t.maintain()).action).toBe("consolidate");
    const grown = parseTx(chain.lastBroadcast).outputs[0].satoshis;
    expect(grown).toBeGreaterThanOrEqual(1701 * COIN);

    // Settled: no further merging, and the retry pays from that one coin.
    expect((await t.maintain()).action).toBe("none");
    const paid = await t.payout({ ...to(6), apiKeyHash: trusted, requestedSats: 1700 * COIN });
    expect(paid.ok && paid.satoshis).toBe(1700 * COIN);
    expect(inputsOf(chain.lastBroadcast)).toHaveLength(1);
  });

  it("stops looking when confirmed coins fall short only by the fee", async () => {
    chain.coins = [...coins(4, POOL), ...coins(1, 600 * COIN, 100), ...coins(1, 401 * COIN + 100, 200)];
    const t = treasury();
    const result = await t.maintain();
    expect(result.action).toBe("none");
    expect(chain.broadcastAttempts).toHaveLength(0);
    expect(await bookedAlarm(t)).toBeNull();
  });

  it("books nothing for a public payout that leaves the collateral coin alone", async () => {
    const collateral = { txid: "c".repeat(64), vout: 0, satoshis: 1002 * COIN, height: 10 };
    chain.coins = [collateral, ...coins(4, POOL)];
    const t = treasury();
    expect((await t.payout(to(5))).ok).toBe(true);
    expect(inputsOf(chain.lastBroadcast)).not.toContain(collateral.txid);
    expect(await bookedAlarm(t)).toBeNull();
  });
});
