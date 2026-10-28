import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "../../src/apikeys";
import { FakeChain } from "./fakechain";
import { RECIPIENT } from "../fixtures";

const chain = new FakeChain();
const COIN = 100_000_000;
const PAYOUT = 10_000_000; // PAYOUT_SATS in vitest.config.ts
const ADMIN = { Authorization: "Bearer test-admin-token" };

let seq = 0;
function treasury() {
  seq += 1;
  return env.TREASURY.get(env.TREASURY.idFromName(`keys-${seq}-${Math.random()}`));
}

function recipient(n = 0) {
  const suffix = n.toString(16).padStart(2, "0");
  return {
    address: `${RECIPIENT.testnet.address}-${n}`,
    pubKeyHash: RECIPIENT.testnet.pubKeyHash.slice(0, 38) + suffix,
    ip: "203.0.113.50",
  };
}

beforeEach(() => {
  chain.height = 100;
  chain.coins = [{ txid: "a".repeat(64), vout: 0, satoshis: 2000 * COIN }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.install();
});

describe("trusted key payouts", () => {
  it("skip the per-IP limit, the address replay and the daily budget", async () => {
    const t = treasury();
    const { token } = await t.createApiKey({ label: "dcg", tier: "trusted" });
    const apiKeyHash = hashApiKey(token);

    // RATE_LIMIT_PER_HOUR is 2 and DAILY_BUDGET_SATS covers 4 payouts; one IP
    // and one address go well past both.
    const txids = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const r = await t.payout({ ...recipient(1), apiKeyHash });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.replay).toBe(false);
      expect(r.satoshis).toBe(PAYOUT);
      txids.add(r.txid);
    }
    expect(txids.size).toBe(6);

    // ...and none of it was charged to the public ledgers.
    const pub = await t.payout({ ...recipient(2) });
    expect(pub.ok).toBe(true);
  });

  it("pay the requested amount, up to the per-request cap", async () => {
    const t = treasury();
    const { token } = await t.createApiKey({ label: "dcg", tier: "trusted" });
    const apiKeyHash = hashApiKey(token);

    const big = await t.payout({ ...recipient(3), apiKeyHash, requestedSats: 1500 * COIN });
    expect(big.ok && big.satoshis).toBe(1500 * COIN);

    const over = await t.payout({ ...recipient(4), apiKeyHash, requestedSats: 2001 * COIN });
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.code).toBe("bad_request");
  });

  it("never take the balance below the public reserve", async () => {
    const t = treasury();
    const { token } = await t.createApiKey({ label: "dcg", tier: "trusted" });
    // 2000 tDASH balance, 1 tDASH reserve.
    const r = await t.payout({ ...recipient(5), apiKeyHash: hashApiKey(token), requestedSats: 1999.5 * COIN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("insufficient_funds");
    expect(chain.broadcastAttempts).toHaveLength(0);
  });

  it("refuse a payout that needs more inputs than one request may sign", async () => {
    // Deep coins, so all twelve count without a coinbase lookup each.
    chain.height = 500;
    chain.coins = Array.from({ length: 12 }, (_, i) => ({
      txid: (i + 1).toString(16).padStart(64, "0"),
      vout: 0,
      satoshis: 100 * COIN,
      height: 10,
    }));
    const t = treasury();
    const { token } = await t.createApiKey({ label: "dcg", tier: "trusted" });
    const r = await t.payout({ ...recipient(6), apiKeyHash: hashApiKey(token), requestedSats: 900 * COIN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("fragmented");
  });

  it("stop working once revoked", async () => {
    const t = treasury();
    const { token, key } = await t.createApiKey({ label: "dcg", tier: "trusted" });
    expect(await t.revokeApiKey(key.id)).toBe(true);
    expect(await t.revokeApiKey(key.id)).toBe(false);
    const r = await t.payout({ ...recipient(7), apiKeyHash: hashApiKey(token) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unauthorized");
  });

  it("reject an unknown key", async () => {
    const r = await treasury().payout({ ...recipient(8), apiKeyHash: hashApiKey("dfk_nope") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unauthorized");
  });
});

describe("mn key payouts", () => {
  it("pay exactly one 1000 DASH collateral, once per day by default", async () => {
    const t = treasury();
    const { token, key } = await t.createApiKey({ label: "mn-op", tier: "mn" });
    expect(key.perDay).toBe(1);
    const apiKeyHash = hashApiKey(token);

    const r = await t.payout({ ...recipient(9), apiKeyHash });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.satoshis).toBe(1000 * COIN);
    expect(r.keyId).toBe(key.id);

    const again = await t.payout({ ...recipient(10), apiKeyHash });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe("rate_limited");

    const [listed] = await t.listApiKeys();
    expect(listed.payouts).toBe(1);
    expect(listed.paidSats).toBe(1000 * COIN);
  });

  it("refuse any other amount", async () => {
    const t = treasury();
    const { token } = await t.createApiKey({ label: "mn-op", tier: "mn", perDay: null });
    const r = await t.payout({ ...recipient(11), apiKeyHash: hashApiKey(token), requestedSats: 5 * COIN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("bad_request");
  });
});

describe("HTTP", () => {
  const url = (path: string) => `https://faucet.test${path}`;

  async function mint(tier: string, extra: Record<string, unknown> = {}) {
    const response = await SELF.fetch(url("/api/admin/keys"), {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ label: "http test", tier, ...extra }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { token: string; key: { id: string } };
  }

  it("admin routes require the admin token", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong" }] as Record<string, string>[]) {
      const response = await SELF.fetch(url("/api/admin/keys"), { headers });
      expect(response.status).toBe(401);
    }
    expect((await SELF.fetch(url("/api/admin/keys"), { headers: ADMIN })).status).toBe(200);
  });

  it("validates admin input", async () => {
    for (const body of [{ label: "", tier: "trusted" }, { label: "x", tier: "god" }, { label: "x", tier: "mn", perDay: 0 }]) {
      const response = await SELF.fetch(url("/api/admin/keys"), {
        method: "POST",
        headers: { ...ADMIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it("pays a key holder with no captcha, and lists and revokes the key", async () => {
    const { token, key } = await mint("trusted");
    expect(token).toMatch(/^dfk_[A-Za-z0-9_-]{43}$/);

    const pay = () =>
      SELF.fetch(url("/api/core-faucet"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ address: RECIPIENT.testnet.address, amount: 12.5 }),
      });
    const ok = await pay();
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { amount: number; keyId: string };
    expect(body.amount).toBe(12.5);
    expect(body.keyId).toBe(key.id);
    expect(chain.siteverifyTokens).toHaveLength(0);

    const list = (await (await SELF.fetch(url("/api/admin/keys"), { headers: ADMIN })).json()) as {
      keys: Array<{ id: string }>;
    };
    expect(list.keys.map((k) => k.id)).toContain(key.id);
    // The listing never exposes secrets.
    expect(JSON.stringify(list)).not.toContain(token);
    expect(JSON.stringify(list)).not.toContain(hashApiKey(token));

    const revoke = await SELF.fetch(url(`/api/admin/keys/${key.id}`), { method: "DELETE", headers: ADMIN });
    expect(revoke.status).toBe(200);
    const denied = await pay();
    expect(denied.status).toBe(401);
  });

  it("rejects malformed keys and amounts", async () => {
    const post = (headers: Record<string, string>, body: unknown) =>
      SELF.fetch(url("/api/core-faucet"), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const address = RECIPIENT.testnet.address;
    expect((await post({ Authorization: "Bearer garbage" }, { address })).status).toBe(401);
    expect((await post({ Authorization: "Basic abc" }, { address })).status).toBe(401);

    const { token } = await mint("trusted");
    const auth = { Authorization: `Bearer ${token}` };
    for (const amount of [0, -1, "5", 1e-9, Number.NaN]) {
      expect((await post(auth, { address, amount })).status).toBe(400);
    }
    // Without a key, amount is not a knob anyone can turn.
    expect((await post({}, { address, amount: 5 })).status).toBe(400);
  });

  it("allows Authorization in CORS preflight", async () => {
    const response = await SELF.fetch(url("/api/core-faucet"), { method: "OPTIONS" });
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});
