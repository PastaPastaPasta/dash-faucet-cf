import { SELF, env, runInDurableObject } from "cloudflare:test";
import DashKeys from "dashkeys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChain } from "./fakechain";
import { FAUCET, RECIPIENT } from "../fixtures";
import { CapParams, checkSolution, subChallenge } from "../../src/cap";
import { TREASURY_ID } from "../../src/treasury";

const chain = new FakeChain();

/** Matches CAP_C / CAP_S / CAP_D in vitest.config.ts. */
const PARAMS: CapParams = { c: 4, s: 32, d: 2 };
/** Matches CAP_HARD_C / CAP_HARD_S / CAP_HARD_D in vitest.config.ts. */
const HARD_PARAMS: CapParams = { c: 4, s: 32, d: 3 };

/**
 * A distinct, checksum-valid testnet address per index. The pubKeyHash is
 * arbitrary — only its uniqueness matters, since the Treasury's daily
 * idempotency keys on the address.
 */
function address(n: number): Promise<string> {
  return DashKeys.pkhToAddr(new Uint8Array(20).fill(n), { version: "testnet" });
}

/**
 * Wipe the one global Treasury the Worker addresses.
 *
 * This pool shares Durable Object storage across the tests in a project, and
 * `/api/core-faucet` always resolves the same named instance, so without this a
 * test's payouts would spend the daily budget and per-IP allowance the *next*
 * test is asserting on.
 */
async function resetTreasury(): Promise<void> {
  const stub = env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
  await runInDurableObject(stub, (_instance, state) => {
    for (const table of ["claims", "ip_hits", "spent", "pending", "budget", "used_cap"]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}

beforeEach(async () => {
  await resetTreasury();
  chain.coins = [{ txid: "b".repeat(64), vout: 0, satoshis: 1_000_000_000 }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.siteverifyTokens.length = 0;
  chain.siteverifySucceeds = true;
  env.TURNSTILE_SECRET = "";
  chain.install();
});

async function post(path: string, body: unknown, ip = "203.0.113.5") {
  const res = await SELF.fetch(`https://faucet.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/**
 * Full client-side handshake against one tier: challenge, solve, redeem.
 *
 * The shape is taken from the challenge response rather than assumed, so this
 * brute-forces whatever the server actually served. Production's hard tier is
 * 50 x 16^6 and must never be solved here; the test config keeps it at
 * 4 x 16^3 for exactly this reason.
 */
async function mintCapToken(tier: "v1" | "hard" = "v1"): Promise<string> {
  const challenge = await post(`/cap/${tier}/challenge`, {});
  expect(challenge.status).toBe(200);
  const token: string = challenge.body.token;
  const params: CapParams = challenge.body.challenge;

  const solutions: number[] = [];
  for (let i = 1; i <= params.c; i += 1) {
    const { salt, target } = subChallenge(token, i, params);
    let nonce = 0;
    while (!checkSolution(salt, target, nonce)) nonce += 1;
    solutions.push(nonce);
  }

  const redeem = await post(`/cap/${tier}/redeem`, { token, solutions });
  expect(redeem.status).toBe(200);
  expect(redeem.body.success).toBe(true);
  return redeem.body.token;
}

describe("cap.js endpoints", () => {
  it("serves a challenge the Swift SDK will accept", async () => {
    const { status, body } = await post("/cap/v1/challenge", {});
    // postJSON in TestnetFaucet.swift throws on anything but 200.
    expect(status).toBe(200);
    expect(body.challenge).toEqual(PARAMS);
    expect(body.token).toMatch(/^[0-9a-f]{50}$/);
    expect(typeof body.expires).toBe("number");
  });

  it("advertises capEndpoint and coreFaucetAmount on /api/status", async () => {
    const res = await SELF.fetch("https://faucet.test/api/status");
    const body = (await res.json()) as Record<string, any>;
    // Both fields are non-optional in the SDK's Decodable, so a missing key
    // fails the whole native flow before it starts.
    expect(body.capEndpoint).toBe("https://faucet.test/cap/v1/");
    // The Swift SDK rejects a non-https endpoint outright.
    expect(String(body.capEndpoint).startsWith("https://")).toBe(true);
    expect(typeof body.coreFaucetAmount).toBe("number");

    // Derived from the request host the same way, so both are right on every
    // hostname the Worker answers on without a redeploy.
    expect(body.hardCapEndpoint).toBe("https://faucet.test/cap/hard/");
    // rateLimitPerHour keeps meaning the soft tier, which is the only tier the
    // clients that read that field ever present.
    expect(body.rateLimitPerHour).toBe(2);
    expect(body.rateLimits).toEqual({ soft: 2, turnstile: 3, hard: 4 });
  });

  it("serves the escalated challenge shape at /cap/hard/", async () => {
    const soft = await post("/cap/v1/challenge", {});
    const hard = await post("/cap/hard/challenge", {});
    expect(soft.body.challenge).toEqual(PARAMS);
    expect(hard.body.challenge).toEqual(HARD_PARAMS);
    expect(hard.body.token).toMatch(/^[0-9a-f]{50}$/);
  });

  it("redeems a solved challenge and funds an address", async () => {
    const capToken = await mintCapToken();
    const { status, body } = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      capToken,
    });
    expect(status).toBe(200);
    expect(body.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never sends a capToken to Turnstile", async () => {
    env.TURNSTILE_SECRET = "turnstile-secret";
    const capToken = await mintCapToken();
    const { status } = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      capToken,
    });
    expect(status).toBe(200);
    // The old code passed `turnstileToken ?? capToken` to siteverify, which
    // would both fail and leak the token to a third party.
    expect(chain.siteverifyTokens).toEqual([]);
  });

  it("still verifies web requests through Turnstile", async () => {
    env.TURNSTILE_SECRET = "turnstile-secret";
    const ok = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      turnstileToken: "web-token",
    });
    expect(ok.status).toBe(200);
    expect(chain.siteverifyTokens).toEqual(["web-token"]);

    chain.siteverifySucceeds = false;
    const bad = await post(
      "/api/core-faucet",
      { address: RECIPIENT.testnet.address, turnstileToken: "web-token" },
      "203.0.113.6",
    );
    expect(bad.status).toBe(400);
    expect(bad.body.requiresProofOfWork).toBe(true);
    expect(bad.body.detail.requiresProofOfWork).toBe(true);
    const fallback = await post("/api/core-faucet", {
      address: await address(80),
      capToken: await mintCapToken(),
    }, "203.0.113.6");
    expect(fallback.status).toBe(200);
    expect(chain.siteverifyTokens).toEqual(["web-token", "web-token"]);
  });

  it("offers PoW when Turnstile verification is unavailable", async () => {
    env.TURNSTILE_SECRET = "turnstile-secret";
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Turnstile unavailable"));
    const failed = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      turnstileToken: "web-token",
    });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toBe("Captcha verification unavailable");
    expect(failed.body.requiresProofOfWork).toBe(true);
    expect(chain.broadcastAttempts).toHaveLength(0);
    const fallback = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      capToken: await mintCapToken(),
    });
    expect(fallback.status).toBe(200);
  });

  it("rejects a replayed capToken", async () => {
    const capToken = await mintCapToken();
    const first = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      capToken,
    });
    expect(first.status).toBe(200);

    // A different address, so the Treasury's own daily idempotency cannot be
    // what answers here.
    const replay = await post("/api/core-faucet", {
      address: FAUCET.testnet.address,
      capToken,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("Captcha token already used");
  });

  it("rejects a tampered capToken", async () => {
    const capToken = await mintCapToken();
    const flipped =
      capToken.slice(0, 100) +
      (capToken[100] === "0" ? "1" : "0") +
      capToken.slice(101);
    const { status, body } = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
      capToken: flipped,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid captcha token");
    expect(body.requiresProofOfWork).toBeUndefined();
  });

  it("rejects a redeem with a wrong nonce or the wrong solution count", async () => {
    const challenge = await post("/cap/v1/challenge", {});
    const token: string = challenge.body.token;

    const wrongCount = await post("/cap/v1/redeem", { token, solutions: [0, 0] });
    expect(wrongCount.status).toBe(400);
    expect(wrongCount.body.success).toBe(false);
    expect(wrongCount.body.error).toBe("Invalid captcha solutions");

    const wrongNonce = await post("/cap/v1/redeem", {
      token,
      solutions: [1, 2, 3, 4],
    });
    expect(wrongNonce.status).toBe(400);
    expect(wrongNonce.body.error).toBe("Captcha solution rejected");
  });

  it("requires a captcha token when one is configured", async () => {
    const { status, body } = await post("/api/core-faucet", {
      address: RECIPIENT.testnet.address,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("Captcha token required");
  });
});

describe("proof-strength rate limit tiers", () => {
  // The test config is a 2/3/4 ladder (soft/turnstile/hard) under a budget that
  // allows exactly four payouts, so one IP can walk the whole ladder and still
  // reach the hard ceiling before the budget answers instead.

  /**
   * One faucet request carrying `proof`, always to an address no earlier
   * request used — the Treasury replays a same-day repeat before it ever
   * reaches the rate-limit check, which would mask every assertion here.
   */
  let n = 0;
  const fund = async (ip: string, proof: Record<string, unknown>) =>
    post("/api/core-faucet", { address: await address((n += 1)), ...proof }, ip);

  it("raises the per-IP hourly limit as the proof gets stronger", async () => {
    env.TURNSTILE_SECRET = "turnstile-secret";
    const ip = "203.0.113.77";
    const to = (proof: Record<string, unknown>) => fund(ip, proof);

    // Soft proof of work: 2/hour.
    expect((await to({ capToken: await mintCapToken() })).status).toBe(200);
    expect((await to({ capToken: await mintCapToken() })).status).toBe(200);

    const softBlocked = await to({ capToken: await mintCapToken() });
    expect(softBlocked.status).toBe(429);
    expect(softBlocked.body.error).toBe("Rate limit exceeded");
    expect(softBlocked.body.retryAfter).toBeGreaterThan(0);
    // Both the flat and the nested envelope carry it, so a client written
    // against the old FastAPI shape sees the escalation hint too.
    expect(softBlocked.body.requiresHardCaptcha).toBe(true);
    expect(softBlocked.body.detail.requiresHardCaptcha).toBe(true);

    // Turnstile outranks the soft proof of work: 3/hour, so the same IP with
    // two hits already recorded gets one more.
    expect((await to({ turnstileToken: "web-token" })).status).toBe(200);
    const turnstileBlocked = await to({ turnstileToken: "web-token" });
    expect(turnstileBlocked.status).toBe(429);
    expect(turnstileBlocked.body.requiresHardCaptcha).toBe(true);

    // Hard proof of work: 4/hour.
    expect((await to({ capToken: await mintCapToken("hard") })).status).toBe(200);

    const hardBlocked = await to({ capToken: await mintCapToken("hard") });
    expect(hardBlocked.status).toBe(429);
    // Nothing stronger left to offer. Advertising escalation here would send
    // the user off to burn another 839M hashes for a guaranteed second 429.
    expect(hardBlocked.body.requiresHardCaptcha).toBeUndefined();
  });

  it("grades the tier from the token, not the field it arrived in", async () => {
    const ip = "203.0.113.88";
    const to = (proof: Record<string, unknown>) => fund(ip, proof);

    // Spend the soft allowance.
    expect((await to({ capToken: await mintCapToken() })).status).toBe(200);
    expect((await to({ capToken: await mintCapToken() })).status).toBe(200);

    // `hardCapToken` is only an alias old web clients used. A soft token posted
    // under it must still be graded soft — the strength is signed into the
    // token's own payload, so the field name claims nothing.
    const lying = await to({ hardCapToken: await mintCapToken() });
    expect(lying.status).toBe(429);
    expect(lying.body.requiresHardCaptcha).toBe(true);

    // The same alias with a genuinely hard token does raise the ceiling.
    const honest = await to({ hardCapToken: await mintCapToken("hard") });
    expect(honest.status).toBe(200);
  });

  it("does not offer escalation when the daily budget is what stopped it", async () => {
    env.TURNSTILE_SECRET = "turnstile-secret";
    // Four payouts exhaust DAILY_BUDGET_SATS. Spread over distinct IPs so the
    // per-IP limit is never what answers.
    for (let i = 0; i < 4; i += 1) {
      const { status } = await fund(`203.0.113.${20 + i}`, {
        turnstileToken: "web-token",
      });
      expect(status).toBe(200);
    }

    const blocked = await fund("203.0.113.99", { turnstileToken: "web-token" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("Faucet daily budget exhausted");
    // The daily budget is the global ceiling; no proof of work moves it.
    expect(blocked.body.requiresHardCaptcha).toBeUndefined();
  });
});
