/**
 * cap.js-compatible proof-of-work captcha.
 *
 * The web UI uses Turnstile, but Turnstile is a *browser* challenge — it needs a
 * JS runtime, a DOM and fingerprinting signals. Native clients (dashwallet-ios'
 * one-tap "get tDash", via `TestnetFaucet.swift` in the Swift SDK) cannot solve
 * it, so they speak the `cap.js` wire protocol instead: fetch a challenge, brute
 * force `c` little SHA-256 prefix searches, redeem the solutions for a token.
 *
 * Be honest about what this buys: the client-side guard caps aggregate work at
 * `c × 16^d ≤ 64M` hashes, which is under a second on a server core, so a bot
 * that takes this path is barely inconvenienced. Accepting a PoW token means the
 * effective captcha strength for *everyone* becomes the PoW. This is
 * compatibility and friction, not a bot defence — the real limits are the
 * durable per-IP limit, the edge limit and `DAILY_BUDGET_SATS`.
 *
 * Everything here is deliberately synchronous. Verifying a redeem costs two PRNG
 * seedings and one SHA-256 per sub-challenge; `crypto.subtle.digest` would turn
 * that into 100 awaits per request, so we use `@noble/hashes` and keep it a
 * tight loop well inside the Workers CPU budget.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Challenge shape as the client sees it: sub-challenges, salt len, target len. */
export interface CapParams {
  c: number;
  s: number;
  d: number;
}

export interface CapChallenge {
  challenge: CapParams;
  token: string;
  /** ms epoch. The Swift SDK ignores this; the real cap.js server sends it. */
  expires: number;
}

/**
 * How long a challenge stays solvable. Long enough that a slow phone finishing a
 * 6.5M-hash search still has room to redeem, short enough that an outstanding
 * challenge is not a durable capability.
 */
export const CHALLENGE_TTL_MS = 10 * 60_000;

/**
 * Extra life a redeemed capToken gets beyond its challenge's expiry. Without it,
 * a client that redeems in the last second of a challenge would be handed a
 * token that is already dead by the time it reaches `/api/core-faucet`.
 */
export const CAP_TOKEN_GRACE_MS = 10 * 60_000;

/** 6 bytes of ms-epoch expiry + 3 bytes of challenge shape + 7 random bytes. */
const PAYLOAD_BYTES = 16;
/** Truncated so that payload+mac is 25 bytes — 50 hex chars, as cap.js emits. */
const TOKEN_MAC_BYTES = 9;
const TOKEN_HEX_LEN = (PAYLOAD_BYTES + TOKEN_MAC_BYTES) * 2;
/** Full HMAC, hex, appended to the challenge token to form the capToken. */
const REDEEM_MAC_HEX_LEN = 64;

const HEX_ONLY = /^[0-9a-f]+$/;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Length-independent, data-independent comparison of two hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function mac(secret: string, domain: string, data: Uint8Array): Uint8Array {
  const message = new Uint8Array(domain.length + data.length);
  message.set(encoder.encode(domain), 0);
  message.set(data, domain.length);
  return hmac(sha256, encoder.encode(secret), message);
}

/**
 * cap.js' seeded PRNG: FNV-1a over the seed, then xorshift32, emitting `length`
 * lowercase hex characters.
 *
 * The Swift solver writes the FNV round as five shifts plus an add; that sum is
 * `2+16+128+256+16777216 + 1 = 0x01000193`, the FNV-1a prime, so `Math.imul` is
 * exactly equivalent. Every step is forced back to unsigned — in particular the
 * middle xorshift is `>>>`, and `toString(16)` on a negative int32 would emit a
 * minus sign rather than the two's-complement bits cap.js expects.
 *
 * This is the one function that absolutely must be bit-identical to
 * `@cap.js/widget`; it is cross-validated against the live cap.js server, not
 * just against our own solver.
 */
export function prng(seed: string, length: number): string {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    state = (state ^ seed.charCodeAt(i)) >>> 0;
    state = Math.imul(state, 0x01000193) >>> 0;
  }

  let out = "";
  while (out.length < length) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    out += state.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/** The salt/target pair for sub-challenge `i` (1-based), per the cap.js scheme. */
export function subChallenge(
  token: string,
  i: number,
  params: CapParams,
): { salt: string; target: string } {
  return {
    salt: prng(`${token}${i}`, params.s),
    target: prng(`${token}${i}d`, params.d),
  };
}

/**
 * True when the lowercase-hex rendering of `digest` starts with `target`.
 *
 * Only the leading `ceil(d/2)` bytes are ever rendered — `d` is at most 6, so
 * this never materialises the full 64-char digest.
 */
export function digestHasPrefix(digest: Uint8Array, target: string): boolean {
  const bytes = (target.length + 1) >> 1;
  let hex = "";
  for (let i = 0; i < bytes; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex.startsWith(target);
}

/** Does `salt + nonce` hash to something starting with `target`? */
export function checkSolution(salt: string, target: string, nonce: number): boolean {
  return digestHasPrefix(sha256(encoder.encode(salt + String(nonce))), target);
}

/**
 * Mint a challenge without storing anything.
 *
 * The token is only ever a PRNG seed, so any lowercase-hex string satisfies the
 * protocol — which lets us make it self-describing instead of stateful:
 *
 *     payload = 6 bytes expiry (ms, big-endian) ‖ c-1 ‖ s-1 ‖ d ‖ 7 random bytes
 *     token   = hex(payload ‖ HMAC(secret, "cap-challenge:" ‖ payload)[0..9])
 *
 * 25 bytes, 50 hex chars, exactly what the real cap.js server emits. Issuing a
 * challenge therefore costs no storage and cannot be exhausted by an attacker
 * hammering `/challenge`.
 *
 * The challenge *shape* rides along inside the MAC rather than being re-read
 * from config at redeem time. Without that, retuning `CAP_C`/`CAP_S`/`CAP_D`
 * would silently reject every honest solve still in flight — the client solved
 * against the old shape while the server graded against the new one. `c` and `s`
 * are stored biased by one so that the full 1..256 range fits a byte.
 */
export function mintChallenge(
  secret: string,
  params: CapParams,
  now: number = Date.now(),
): CapChallenge {
  const expires = now + CHALLENGE_TTL_MS;

  const payload = new Uint8Array(PAYLOAD_BYTES);
  // 6 bytes of milliseconds carries us past the year 10000; JS bit ops are
  // 32-bit, so the value is sliced with arithmetic rather than shifts.
  payload[0] = Math.floor(expires / 2 ** 40) & 0xff;
  payload[1] = Math.floor(expires / 2 ** 32) & 0xff;
  payload[2] = Math.floor(expires / 2 ** 24) & 0xff;
  payload[3] = Math.floor(expires / 2 ** 16) & 0xff;
  payload[4] = Math.floor(expires / 2 ** 8) & 0xff;
  payload[5] = expires & 0xff;
  payload[6] = params.c - 1;
  payload[7] = params.s - 1;
  payload[8] = params.d;
  crypto.getRandomValues(payload.subarray(9));

  const tag = mac(secret, "cap-challenge:", payload).subarray(0, TOKEN_MAC_BYTES);
  return {
    challenge: { ...params },
    token: toHex(payload) + toHex(tag),
    expires,
  };
}

type TokenParse =
  | { ok: true; expires: number; params: CapParams }
  | { ok: false; reason: string };

/**
 * Re-derive a challenge token's MAC and read back what it commits to: the expiry
 * and the challenge shape it was issued with. No storage is consulted, and no
 * deadline is applied here — a challenge dies at `expires`, but a capToken
 * minted from it lives a grace period longer, so the caller owns that decision.
 */
function parseToken(secret: string, token: string): TokenParse {
  if (token.length !== TOKEN_HEX_LEN || !HEX_ONLY.test(token)) {
    return { ok: false, reason: "Invalid captcha token" };
  }
  const payloadHex = token.slice(0, PAYLOAD_BYTES * 2);
  const tagHex = token.slice(PAYLOAD_BYTES * 2);
  const expected = toHex(
    mac(secret, "cap-challenge:", fromHex(payloadHex)).subarray(0, TOKEN_MAC_BYTES),
  );
  if (!timingSafeEqualHex(tagHex, expected)) {
    return { ok: false, reason: "Invalid captcha token" };
  }

  // Big-endian 48-bit expiry, reassembled with arithmetic rather than bit ops so
  // that bits 32 and above survive.
  const payload = fromHex(payloadHex);
  let expires = 0;
  for (let i = 0; i < 6; i++) expires = expires * 256 + payload[i];

  return {
    ok: true,
    expires,
    params: { c: payload[6] + 1, s: payload[7] + 1, d: payload[8] },
  };
}

/**
 * The capToken handed back on a successful redeem.
 *
 * `/api/core-faucet` receives only this string, so it has to be self-verifying:
 * the challenge token travels inside it and the appended HMAC proves we issued
 * it. That keeps redeem stateless too — the *only* state the captcha needs is
 * the spent-set that enforces single use, and that lives in the Treasury.
 *
 * It is deterministic in the challenge token, so replaying the same
 * `{token, solutions}` yields the same capToken. That is why single use on the
 * capToken alone is sufficient: a replayed redeem cannot manufacture a second
 * spendable token.
 */
export function deriveCapToken(secret: string, token: string): string {
  return token + toHex(mac(secret, "cap-redeem:", encoder.encode(token)));
}

export type RedeemResult =
  | { ok: true; capToken: string; expiresAt: number }
  | { ok: false; reason: string };

/**
 * Verify a full set of solutions against the shape the token itself commits to.
 *
 * Order matters for cost: the cheap structural checks (token shape, MAC, expiry,
 * solution count) all run before a single hash, so junk is rejected without
 * doing the work an attacker was hoping to make us do.
 */
export function verifySolutions(
  secret: string,
  token: unknown,
  solutions: unknown,
  now: number = Date.now(),
): RedeemResult {
  if (typeof token !== "string") {
    return { ok: false, reason: "Invalid captcha token" };
  }

  const parsed = parseToken(secret, token);
  if (!parsed.ok) return parsed;
  if (now > parsed.expires) {
    return { ok: false, reason: "Captcha challenge expired" };
  }

  const params = parsed.params;
  if (!Array.isArray(solutions) || solutions.length !== params.c) {
    return { ok: false, reason: "Invalid captcha solutions" };
  }

  for (let i = 1; i <= params.c; i++) {
    const nonce = solutions[i - 1];
    // Nonces are array indices into a brute-force search: any non-integer, or a
    // negative, cannot be what the solver found.
    if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0) {
      return { ok: false, reason: "Invalid captcha solutions" };
    }
    const { salt, target } = subChallenge(token, i, params);
    if (!checkSolution(salt, target, nonce)) {
      return { ok: false, reason: "Captcha solution rejected" };
    }
  }

  return {
    ok: true,
    capToken: deriveCapToken(secret, token),
    expiresAt: parsed.expires + CAP_TOKEN_GRACE_MS,
  };
}

export type CapTokenCheck =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: string };

/**
 * Verify a capToken presented to `/api/core-faucet`. Proves *authenticity* only;
 * single use is the caller's job (see `Treasury.consumeCapToken`).
 */
export function verifyCapToken(
  secret: string,
  capToken: string,
  now: number = Date.now(),
): CapTokenCheck {
  if (
    capToken.length !== TOKEN_HEX_LEN + REDEEM_MAC_HEX_LEN ||
    !HEX_ONLY.test(capToken)
  ) {
    return { ok: false, reason: "Invalid captcha token" };
  }
  const token = capToken.slice(0, TOKEN_HEX_LEN);

  const parsed = parseToken(secret, token);
  if (!parsed.ok) return parsed;
  if (!timingSafeEqualHex(capToken, deriveCapToken(secret, token))) {
    return { ok: false, reason: "Invalid captcha token" };
  }

  const expiresAt = parsed.expires + CAP_TOKEN_GRACE_MS;
  if (now > expiresAt) return { ok: false, reason: "Captcha token expired" };

  return { ok: true, expiresAt };
}
