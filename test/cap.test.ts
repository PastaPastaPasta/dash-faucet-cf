import { describe, expect, it } from "vitest";
import {
  CAP_TOKEN_GRACE_MS,
  CHALLENGE_TTL_MS,
  CapParams,
  capWork,
  checkSolution,
  deriveCapToken,
  mintChallenge,
  prng,
  subChallenge,
  verifyCapToken,
  verifySolutions,
} from "../src/cap";

const SECRET = "test-cap-secret-do-not-use";

/** Cheap enough to brute force in a test: 4 sub-challenges of ~256 tries. */
const PARAMS: CapParams = { c: 4, s: 32, d: 2 };

/** The client half of the protocol, mirroring `CapSolver` in TestnetFaucet.swift. */
function solve(token: string, params: CapParams): number[] {
  const out: number[] = [];
  for (let i = 1; i <= params.c; i += 1) {
    const { salt, target } = subChallenge(token, i, params);
    let nonce = 0;
    while (!checkSolution(salt, target, nonce)) nonce += 1;
    out.push(nonce);
  }
  return out;
}

describe("prng", () => {
  // Captured from a real challenge issued by the live cap.js server at
  // cap.thepasta.org, whose /redeem accepted the nonce below. That acceptance is
  // what proves this implementation is bit-identical to @cap.js/widget — these
  // are not self-generated fixtures.
  const LIVE_TOKEN = "b987380d8edbb0448190cd10094bc26769dc7bdaef08c2d89e";

  it("matches the live cap.js server's salt and target", () => {
    expect(prng(`${LIVE_TOKEN}1`, 32)).toBe("956fc0cbc3a458705de5f885bc50161f");
    expect(prng(`${LIVE_TOKEN}1d`, 4)).toBe("7a4f");
  });

  it("agrees with the nonce the live server accepted", () => {
    expect(checkSolution("956fc0cbc3a458705de5f885bc50161f", "7a4f", 97269)).toBe(true);
    expect(checkSolution("956fc0cbc3a458705de5f885bc50161f", "7a4f", 97268)).toBe(false);
  });

  it("emits exactly `length` lowercase hex characters", () => {
    for (const n of [1, 4, 8, 9, 32, 33]) {
      expect(prng("seed", n)).toMatch(new RegExp(`^[0-9a-f]{${n}}$`));
    }
  });

  it("keeps the xorshift state unsigned", () => {
    // A signed `>>` or a missing `>>> 0` shows up as a "-" from toString(16) or
    // as a short group, so every 8-char group must be full-width hex.
    for (let i = 0; i < 64; i += 1) {
      expect(prng(`x${i}`, 64)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is sensitive to the whole seed", () => {
    expect(prng("token1", 16)).not.toBe(prng("token1d", 16));
    expect(prng("token1", 16)).not.toBe(prng("token2", 16));
  });
});

describe("challenge minting", () => {
  it("looks exactly like a cap.js challenge", () => {
    const minted = mintChallenge(SECRET, PARAMS, 1_700_000_000_000);
    expect(minted.token).toMatch(/^[0-9a-f]{50}$/);
    expect(minted.challenge).toEqual(PARAMS);
    expect(minted.expires).toBe(1_700_000_000_000 + CHALLENGE_TTL_MS);
  });

  it("never repeats a token", () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => mintChallenge(SECRET, PARAMS).token),
    );
    expect(seen.size).toBe(50);
  });
});

describe("verifySolutions", () => {
  it("accepts a correctly solved challenge", () => {
    const { token } = mintChallenge(SECRET, PARAMS);
    const result = verifySolutions(SECRET, token, solve(token, PARAMS));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capToken).toBe(deriveCapToken(SECRET, token));
    expect(result.capToken.startsWith(token)).toBe(true);
  });

  it("returns the same capToken when a redeem is replayed", () => {
    // This is what lets single-use be enforced on the capToken alone: a replayed
    // redeem cannot mint a second spendable token.
    const { token } = mintChallenge(SECRET, PARAMS);
    const solutions = solve(token, PARAMS);
    const first = verifySolutions(SECRET, token, solutions);
    const second = verifySolutions(SECRET, token, solutions);
    expect(first.ok && second.ok && first.capToken === second.capToken).toBe(true);
  });

  it("rejects a single wrong nonce", () => {
    const { token } = mintChallenge(SECRET, PARAMS);
    const solutions = solve(token, PARAMS);
    solutions[PARAMS.c - 1] += 1;
    expect(verifySolutions(SECRET, token, solutions)).toEqual({
      ok: false,
      reason: "Captcha solution rejected",
    });
  });

  it("rejects the wrong number of solutions", () => {
    const { token } = mintChallenge(SECRET, PARAMS);
    const solutions = solve(token, PARAMS);
    for (const bad of [solutions.slice(1), [...solutions, 0], []]) {
      expect(verifySolutions(SECRET, token, bad)).toEqual({
        ok: false,
        reason: "Invalid captcha solutions",
      });
    }
  });

  it("rejects non-integer and negative nonces", () => {
    const { token } = mintChallenge(SECRET, PARAMS);
    for (const bad of [-1, 1.5, Number.NaN, "0", null]) {
      const solutions: unknown[] = solve(token, PARAMS);
      solutions[0] = bad;
      expect(verifySolutions(SECRET, token, solutions)).toEqual({
        ok: false,
        reason: "Invalid captcha solutions",
      });
    }
  });

  it("rejects a tampered token", () => {
    const { token } = mintChallenge(SECRET, PARAMS);
    const solutions = solve(token, PARAMS);
    // Flip one hex digit of the random half; the MAC no longer covers it.
    const flipped =
      token.slice(0, 20) +
      (token[20] === "0" ? "1" : "0") +
      token.slice(21);
    expect(verifySolutions(SECRET, flipped, solutions)).toEqual({
      ok: false,
      reason: "Invalid captcha token",
    });
  });

  it("rejects a token minted under a different secret", () => {
    const { token } = mintChallenge("some-other-secret", PARAMS);
    expect(verifySolutions(SECRET, token, solve(token, PARAMS))).toEqual({
      ok: false,
      reason: "Invalid captcha token",
    });
  });

  it("rejects an expired challenge", () => {
    const now = 1_700_000_000_000;
    const { token } = mintChallenge(SECRET, PARAMS, now);
    const solutions = solve(token, PARAMS);
    expect(verifySolutions(SECRET, token, solutions, now + 60_000).ok).toBe(true);
    expect(
      verifySolutions(SECRET, token, solutions, now + CHALLENGE_TTL_MS + 1),
    ).toEqual({ ok: false, reason: "Captcha challenge expired" });
  });

  it("grades against the shape the token was minted with, not current config", () => {
    // Retuning CAP_C/CAP_S/CAP_D must not reject an honest solve that is already
    // in flight, so c/s/d ride inside the token's MAC rather than being re-read
    // from config at redeem time.
    const other: CapParams = { c: 4, s: 16, d: 2 };
    const { token } = mintChallenge(SECRET, other);
    expect(verifySolutions(SECRET, token, solve(token, other)).ok).toBe(true);
    expect(verifySolutions(SECRET, token, solve(token, PARAMS))).toEqual({
      ok: false,
      reason: "Captcha solution rejected",
    });
  });

  it("round-trips the full 1..256 range of c", () => {
    // c and s are stored biased by one so 256 fits in a byte; a naive encoding
    // would wrap 256 to 0 here.
    const { token } = mintChallenge(SECRET, { c: 256, s: 256, d: 1 });
    expect(verifySolutions(SECRET, token, new Array(255).fill(0))).toEqual({
      ok: false,
      reason: "Invalid captcha solutions",
    });
    // Right length, wrong nonces — proves the token really said c = 256.
    expect(verifySolutions(SECRET, token, new Array(256).fill(0))).toEqual({
      ok: false,
      reason: "Captcha solution rejected",
    });
  });

  it("rejects garbage before doing any hashing", () => {
    expect(verifySolutions(SECRET, 42, [0, 0, 0, 0])).toEqual({
      ok: false,
      reason: "Invalid captcha token",
    });
    expect(verifySolutions(SECRET, "zz", [0, 0, 0, 0])).toEqual({
      ok: false,
      reason: "Invalid captcha token",
    });
    expect(verifySolutions(SECRET, "x".repeat(50), [0, 0, 0, 0])).toEqual({
      ok: false,
      reason: "Invalid captcha token",
    });
  });
});

describe("verifyCapToken", () => {
  function issue(now = Date.now()) {
    const { token } = mintChallenge(SECRET, PARAMS, now);
    const result = verifySolutions(SECRET, token, solve(token, PARAMS), now);
    if (!result.ok) throw new Error("solve failed");
    return result.capToken;
  }

  it("accepts a capToken it issued", () => {
    const now = 1_700_000_000_000;
    const capToken = issue(now);
    expect(verifyCapToken(SECRET, capToken, now)).toEqual({
      ok: true,
      expiresAt: now + CHALLENGE_TTL_MS + CAP_TOKEN_GRACE_MS,
      params: PARAMS,
    });
  });

  it("reports the challenge shape the token was minted with", () => {
    // This is what makes proof-strength tiers stateless: the difficulty is
    // inside the same MAC'd payload that authenticates the token, so a soft
    // solve cannot be presented as a hard one, and no lookup table is needed to
    // find out which it was.
    const hard: CapParams = { c: 8, s: 32, d: 3 };
    const { token } = mintChallenge(SECRET, hard);
    const redeemed = verifySolutions(SECRET, token, solve(token, hard));
    if (!redeemed.ok) throw new Error("solve failed");

    const check = verifyCapToken(SECRET, redeemed.capToken);
    expect(check.ok && check.params).toEqual(hard);
    expect(capWork(hard)).toBeGreaterThan(capWork(PARAMS));
  });

  it("survives its challenge's expiry by the grace period", () => {
    // A client that redeems in the last second of a challenge must still be able
    // to spend the token it was just handed.
    const now = 1_700_000_000_000;
    const capToken = issue(now);
    const deadline = now + CHALLENGE_TTL_MS + CAP_TOKEN_GRACE_MS;
    expect(verifyCapToken(SECRET, capToken, deadline).ok).toBe(true);
    expect(verifyCapToken(SECRET, capToken, deadline + 1)).toEqual({
      ok: false,
      reason: "Captcha token expired",
    });
  });

  it("rejects a tampered or truncated capToken", () => {
    const capToken = issue();
    const flipped =
      capToken.slice(0, 80) +
      (capToken[80] === "0" ? "1" : "0") +
      capToken.slice(81);
    expect(verifyCapToken(SECRET, flipped).ok).toBe(false);
    expect(verifyCapToken(SECRET, capToken.slice(0, 50)).ok).toBe(false);
    expect(verifyCapToken(SECRET, `${capToken}00`).ok).toBe(false);
    expect(verifyCapToken(SECRET, "").ok).toBe(false);
  });

  it("rejects a capToken forged under another secret", () => {
    expect(verifyCapToken(SECRET, issue().slice(0, 50) + "0".repeat(64)).ok).toBe(false);
    const { token } = mintChallenge(SECRET, PARAMS);
    expect(verifyCapToken(SECRET, deriveCapToken("other-secret", token)).ok).toBe(false);
  });
});
