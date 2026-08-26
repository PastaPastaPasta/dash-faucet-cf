import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeChain } from "./fakechain";
import { RECIPIENT } from "../fixtures";

const chain = new FakeChain();

/** A distinct Treasury per test, so isolated storage really is isolated. */
let seq = 0;
function treasury() {
  seq += 1;
  return env.TREASURY.get(env.TREASURY.idFromName(`test-${seq}-${Math.random()}`));
}

const PAYOUT = 10_000_000; // matches PAYOUT_SATS in vitest.config.ts

function recipient(n = 0) {
  // Distinct 20-byte pubKeyHashes; only their uniqueness matters here.
  const suffix = n.toString(16).padStart(2, "0");
  return {
    address: `${RECIPIENT.testnet.address}-${n}`,
    pubKeyHash: RECIPIENT.testnet.pubKeyHash.slice(0, 38) + suffix,
    ip: `198.51.100.${10 + n}`,
  };
}

beforeEach(() => {
  chain.coins = [{ txid: "a".repeat(64), vout: 0, satoshis: 1_000_000_000 }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.install();
});

describe("payout", () => {
  it("pays, then replays instead of paying twice", async () => {
    const t = treasury();
    const who = recipient(1);

    const first = await t.payout(who);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replay).toBe(false);
    expect(first.satoshis).toBe(PAYOUT);

    const second = await t.payout(who);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replay).toBe(true);
    expect(second.txid).toBe(first.txid);
  });

  it("enforces the per-IP hourly limit", async () => {
    const t = treasury();
    const ip = "203.0.113.9";
    // RATE_LIMIT_PER_HOUR is 2 in the test config.
    for (let i = 0; i < 2; i += 1) {
      const r = await t.payout({ ...recipient(20 + i), ip });
      expect(r.ok).toBe(true);
    }
    const blocked = await t.payout({ ...recipient(99), ip });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe("rate_limited");
    if (blocked.code !== "rate_limited") return;
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("stops at the daily budget even from fresh IPs", async () => {
    const t = treasury();
    // DAILY_BUDGET_SATS is 45_000_000 — four payouts of 10_000_000 fit, a
    // fifth does not, no matter which IP asks.
    for (let i = 0; i < 4; i += 1) {
      expect((await t.payout(recipient(30 + i))).ok).toBe(true);
    }

    const blocked = await t.payout(recipient(35));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.code).toBe("budget_exhausted");
  });

  it("serialises concurrent payouts onto distinct coins", async () => {
    const t = treasury();
    // One coin, three simultaneous requests: each must chain off the previous
    // one's change rather than all selecting the same input.
    const results = await Promise.all([
      t.payout(recipient(40)),
      t.payout(recipient(41)),
      t.payout(recipient(42)),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const txids = results.flatMap((r) => (r.ok ? [r.txid] : []));
    expect(new Set(txids).size).toBe(3);

    const snap = await t.snapshot();
    // The original coin is spent; only the newest change remains spendable.
    expect(snap.availableUtxos).toBe(1);
    expect(snap.spentToday).toBe(3 * PAYOUT);
  });
});

describe("broadcast settlement", () => {
  it("does not record a claim when the broadcast is unresolved", async () => {
    const t = treasury();
    const who = recipient(50);
    chain.broadcast = { kind: "silence" };

    const result = await t.payout(who);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("chain_unavailable");

    // The coin must be locked, not handed back for immediate reuse: a retry
    // that picked a different coin would be a second, real payment.
    chain.broadcast = { kind: "accept" };
    const snap = await t.snapshot();
    expect(snap.availableUtxos).toBe(0);
    expect(snap.spentToday).toBe(0);
  });

  it("retries an unresolved broadcast before giving up", async () => {
    const t = treasury();
    chain.broadcast = { kind: "silence" };
    await t.payout(recipient(51));
    // Two relays, each attempted twice. The two relays wrap the transaction
    // differently, but the transaction itself must be byte-identical every
    // time — a rebroadcast of the same bytes has the same txid and so can
    // never double-pay.
    expect(chain.broadcastAttempts.length).toBe(4);
    const hexes = chain.broadcastAttempts.map((body) => {
      const parsed = JSON.parse(body);
      return parsed.rawtx ?? parsed.params[0];
    });
    expect(new Set(hexes).size).toBe(1);
  });

  it("treats a silent broadcast as success once the tx is observed on-chain", async () => {
    const t = treasury();
    const who = recipient(52);
    chain.broadcast = { kind: "silent-but-live" };

    const result = await t.payout(who);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // It really did land, so the claim and the budget must both reflect it.
    const replay = await t.payout(who);
    expect(replay.ok && replay.replay).toBe(true);
    const snap = await t.snapshot();
    expect(snap.spentToday).toBe(PAYOUT);
  });

  it("locks the coin when the network says the inputs are already gone", async () => {
    const t = treasury();
    chain.broadcast = { kind: "reject", message: "bad-txns-inputs-missingorspent" };

    const result = await t.payout(recipient(53));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("chain_unavailable");

    chain.broadcast = { kind: "accept" };
    const snap = await t.snapshot();
    expect(snap.availableUtxos).toBe(0);
  });

  it("keeps the coin when the rejection is our own fault", async () => {
    const t = treasury();
    chain.broadcast = { kind: "reject", message: "dust" };

    expect((await t.payout(recipient(54))).ok).toBe(false);

    // The inputs were never consumed, so they must stay spendable.
    chain.broadcast = { kind: "accept" };
    const snap = await t.snapshot();
    expect(snap.availableUtxos).toBe(1);
  });
});

describe("maintenance", () => {
  it("splits a single large coin into a pool", async () => {
    const t = treasury();
    const result = await t.maintain();
    expect(result.action).toBe("split");

    const snap = await t.snapshot();
    expect(snap.poolUtxos).toBeGreaterThanOrEqual(2);
  });

  it("does nothing when the pool is already deep enough", async () => {
    const t = treasury();
    chain.coins = [
      { txid: "b".repeat(64), vout: 0, satoshis: 500_000_000 },
      { txid: "c".repeat(64), vout: 0, satoshis: 500_000_000 },
    ];
    const result = await t.maintain();
    expect(result.action).toBe("none");
  });

  it("does not record a split whose broadcast was unresolved", async () => {
    const t = treasury();
    chain.broadcast = { kind: "silence" };
    const result = await t.maintain();
    expect(result.action).toBe("blocked");
  });
});

describe("ledger reconciliation", () => {
  it("drops a pending change output when the spend that consumed it settles", async () => {
    const t = treasury();

    // The first payout records its change in `pending`. The second spends that
    // change before the explorers ever list it as unspent — the burst path
    // `pending` exists to enable — so the outpoint goes straight from unknown
    // to consumed without ever entering the confirmed UTXO set, which is why
    // the `confirmed` check in reconcile can never clear it.
    expect((await t.payout(recipient(7))).ok).toBe(true);
    expect((await t.payout(recipient(8))).ok).toBe(true);

    const before = await t.snapshot();

    // Age only the `spent` rows past SPENT_SETTLED_MS (30 min), leaving
    // `pending` timestamps alone so this exercises reconcile rather than the
    // PENDING_TTL_MS backstop.
    await runInDurableObject(t, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE spent SET created_at = ?`,
        Date.now() - 31 * 60_000,
      );
    });

    // Settling a spend must not change what we think we own. Before the fix the
    // `spent` row was dropped here while its `pending` twin survived, so the
    // consumed change reappeared as a phantom coin and the balance went *up*.
    const after = await t.snapshot();
    expect(after.balanceSats).toBe(before.balanceSats);
    expect(after.availableUtxos).toBe(before.availableUtxos);
  });
});
