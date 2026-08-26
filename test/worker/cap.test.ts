import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeChain } from "./fakechain";
import { FAUCET, RECIPIENT } from "../fixtures";
import { CapParams, checkSolution, subChallenge } from "../../src/cap";

const chain = new FakeChain();

/** Matches CAP_C / CAP_S / CAP_D in vitest.config.ts. */
const PARAMS: CapParams = { c: 4, s: 32, d: 2 };

beforeEach(() => {
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

/** Full client-side handshake: challenge, solve, redeem. */
async function mintCapToken(): Promise<string> {
  const challenge = await post("/cap/v1/challenge", {});
  expect(challenge.status).toBe(200);
  const token: string = challenge.body.token;

  const solutions: number[] = [];
  for (let i = 1; i <= PARAMS.c; i += 1) {
    const { salt, target } = subChallenge(token, i, PARAMS);
    let nonce = 0;
    while (!checkSolution(salt, target, nonce)) nonce += 1;
    solutions.push(nonce);
  }

  const redeem = await post("/cap/v1/redeem", { token, solutions });
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
    const body = (await res.json()) as Record<string, unknown>;
    // Both fields are non-optional in the SDK's Decodable, so a missing key
    // fails the whole native flow before it starts.
    expect(body.capEndpoint).toBe("https://faucet.test/cap/v1/");
    // The Swift SDK rejects a non-https endpoint outright.
    expect(String(body.capEndpoint).startsWith("https://")).toBe(true);
    expect(typeof body.coreFaucetAmount).toBe("number");
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
