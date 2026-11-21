import { SELF, env, runInDurableObject } from "cloudflare:test";
import DashKeys from "dashkeys";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeChain } from "./fakechain";
import { CapParams, checkSolution, subChallenge } from "../../src/cap";
import { TREASURY_ID } from "../../src/treasury";

// vitest.config.ts: payout 0.1, any captcha up to 0.2, Turnstile up to 0.4,
// 0.6 per IP per day, 0.45 daily budget, Turnstile 3/hour per IP.
const chain = new FakeChain();

function address(n: number): Promise<string> {
  return DashKeys.pkhToAddr(new Uint8Array(20).fill(n), { version: "testnet" });
}

beforeEach(async () => {
  const stub = env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
  await runInDurableObject(stub, (_instance, state) => {
    for (const table of ["claims", "ip_hits", "spent", "pending", "budget", "used_cap"]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  chain.coins = [{ txid: "e".repeat(64), vout: 0, satoshis: 1_000_000_000 }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.siteverifyTokens.length = 0;
  chain.siteverifySucceeds = true;
  env.TURNSTILE_SECRET = "turnstile-secret";
  chain.install();
});

async function post(path: string, body: unknown, ip = "203.0.113.70") {
  const res = await SELF.fetch(`https://faucet.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function mintCapToken(): Promise<string> {
  const challenge = await post("/cap/v1/challenge", {});
  const token: string = challenge.body.token;
  const params: CapParams = challenge.body.challenge;
  const solutions: number[] = [];
  for (let i = 1; i <= params.c; i += 1) {
    const { salt, target } = subChallenge(token, i, params);
    let nonce = 0;
    while (!checkSolution(salt, target, nonce)) nonce += 1;
    solutions.push(nonce);
  }
  return (await post("/cap/v1/redeem", { token, solutions })).body.token;
}

describe("requested amounts", () => {
  it("are published in status", async () => {
    const res = await SELF.fetch("https://faucet.test/api/status");
    const body = (await res.json()) as Record<string, any>;
    expect(body.amountLimits).toEqual({ turnstileAbove: 0.2, publicMax: 0.4, signedInMax: 2000, perIpDaily: 0.6 });
  });

  it("refuse proof of work above the Turnstile threshold, without spending the token", async () => {
    const capToken = await mintCapToken();
    const refused = await post("/api/core-faucet", { address: await address(1), capToken, amount: 0.3 });
    expect(refused.status).toBe(400);
    expect(refused.body.requiresTurnstile).toBe(true);
    expect(chain.broadcastAttempts).toHaveLength(0);

    // The same token still pays a small amount.
    const small = await post("/api/core-faucet", { address: await address(1), capToken, amount: 0.2 });
    expect(small.status).toBe(200);
    expect(small.body.amount).toBe(0.2);
  });

  it("pay up to the public maximum with Turnstile", async () => {
    const ok = await post("/api/core-faucet", { address: await address(2), turnstileToken: "t", amount: 0.4 });
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBe(0.4);
  });

  it("need a sign-in or a code above the public maximum, before any captcha is checked", async () => {
    const res = await post("/api/core-faucet", { address: await address(3), turnstileToken: "t", amount: 0.41 });
    expect(res.status).toBe(403);
    expect(res.body.requiresSignIn).toBe(true);
    expect(res.body.accountUrl).toBe("https://faucet.test/keys");
    expect(chain.siteverifyTokens).toHaveLength(0);
  });

  it("count against a per-IP daily allowance that a harder proof cannot raise", async () => {
    const ip = "203.0.113.71";
    expect((await post("/api/core-faucet", { address: await address(4), turnstileToken: "t", amount: 0.4 }, ip)).status).toBe(200);
    const over = await post("/api/core-faucet", { address: await address(5), turnstileToken: "t", amount: 0.3 }, ip);
    expect(over.status).toBe(429);
    expect(over.body.requiresHardCaptcha).toBeUndefined();
    expect(over.body.detailMessage).toMatch(/0\.2 of the 0\.6/);
    expect(over.body.retryAfter).toBeGreaterThan(0);

    // A smaller ask still pays (0.05, so the 0.45 daily budget does not bite).
    expect((await post("/api/core-faucet", { address: await address(5), turnstileToken: "t", amount: 0.05 }, ip)).status).toBe(200);
  });

  it("do not offer the hard proof of work when the amount needs Turnstile anyway", async () => {
    const ip = "203.0.113.72";
    for (let n = 0; n < 3; n += 1) {
      const r = await post("/api/core-faucet", { address: await address(10 + n), turnstileToken: "t", amount: 0.1 }, ip);
      expect(r.status).toBe(200);
    }
    const large = await post("/api/core-faucet", { address: await address(13), turnstileToken: "t", amount: 0.3 }, ip);
    expect(large.status).toBe(429);
    expect(large.body.requiresHardCaptcha).toBeUndefined();
    const small = await post("/api/core-faucet", { address: await address(13), turnstileToken: "t" }, ip);
    expect(small.status).toBe(429);
    expect(small.body.requiresHardCaptcha).toBe(true);
  });

  it("charge the daily budget by amount", async () => {
    // Budget 0.45: 0.4 fits, another 0.1 does not.
    expect((await post("/api/core-faucet", { address: await address(20), turnstileToken: "t", amount: 0.4 }, "203.0.113.73")).status).toBe(200);
    const next = await post("/api/core-faucet", { address: await address(21), turnstileToken: "t" }, "203.0.113.74");
    expect(next.status).toBe(429);
    expect(next.body.error).toBe("Faucet daily budget exhausted");
  });

  it("share a smaller daily slice when large, leaving room for small asks", async () => {
    expect((await post("/api/core-faucet", { address: await address(30), turnstileToken: "t", amount: 0.3 }, "203.0.113.75")).status).toBe(200);
    const second = await post("/api/core-faucet", { address: await address(31), turnstileToken: "t", amount: 0.3 }, "203.0.113.76");
    expect(second.status).toBe(429);
    expect(second.body.detailMessage).toMatch(/Large requests are used up/);
    expect((await post("/api/core-faucet", { address: await address(31), turnstileToken: "t" }, "203.0.113.76")).status).toBe(200);
  });

  it("need Turnstile for a code worth more than the threshold, even without an amount", async () => {
    const created = await SELF.fetch("https://faucet.test/api/admin/codes", {
      method: "POST",
      headers: { Authorization: "Bearer test-admin-token", "content-type": "application/json" },
      body: JSON.stringify({ kind: "event", code: `BIG-${Date.now()}`, label: "big", amount: 0.3, maxRedemptions: 5 }),
    });
    expect(created.status).toBe(201);
    const { codes } = (await created.json()) as { codes: Array<{ code: string }> };

    const pow = await post("/api/core-faucet", { address: await address(40), capToken: await mintCapToken(), code: codes[0].code }, "203.0.113.77");
    expect(pow.status).toBe(400);
    expect(pow.body.requiresTurnstile).toBe(true);
    expect(chain.broadcastAttempts).toHaveLength(0);

    const ok = await post("/api/core-faucet", { address: await address(40), turnstileToken: "t", code: codes[0].code }, "203.0.113.77");
    expect(ok.status).toBe(200);
    expect(ok.body.amount).toBe(0.3);
  });
});
