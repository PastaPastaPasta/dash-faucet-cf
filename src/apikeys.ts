/**
 * API keys: bearer credentials that replace the captcha for trusted callers.
 *
 * A key is `dfk_` plus 32 random bytes in base64url. Only its SHA-256 is stored
 * (in the Treasury, so revocation and per-key limits are checked in the same
 * transaction as the payout); the plaintext is shown once, at creation. Keys
 * are high-entropy, so a plain hash is enough — there is nothing to brute-force.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { COIN } from "./config";
import { bytesToHex } from "./keys";

/**
 * - `trusted`: DCG and other authorized callers. No captcha, no per-IP limit,
 *   no daily budget; the caller picks `amount` up to the per-request sanity cap.
 * - `mn`: one masternode collateral per call — exactly 1000 tDASH in a single
 *   output — for testnet MN operators. Limited per day by the key's `perDay`.
 */
export type KeyTier = "trusted" | "mn";
export const KEY_TIERS: readonly KeyTier[] = ["trusted", "mn"];

/** A regular masternode's collateral. Must arrive as exactly one output. */
export const MN_COLLATERAL_SATS = 1000 * COIN;

/** Per-day payout count a new key of each tier gets unless the admin overrides it. */
export const DEFAULT_PER_DAY: Record<KeyTier, number | null> = {
  trusted: null,
  mn: 1,
};

const PREFIX = "dfk_";

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hashApiKey(token: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}

/** Short, non-secret handle for listing and revoking a key. */
export function keyId(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * The bearer token from an `Authorization` header, or undefined when there is
 * none. A header that is present but not a `dfk_` bearer is returned as-is so
 * the caller can reject it rather than silently fall back to the captcha path.
 */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : header;
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX) && token.length === PREFIX.length + 43;
}

/** Constant-time string comparison (digests, MACs, tokens). */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 0.001 DASH: comfortably above dust, below anything anyone asks for. */
const MIN_PAYOUT_SATS = 100_000;

/**
 * `amount` in DASH as whole duffs, or undefined when it is not a usable
 * amount. Anything finer than a duff is a unit mistake, not a request; the
 * floor keeps a typo from building an unrelayable dust output.
 */
export function parseAmountSats(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const sats = Math.round(value * COIN);
  if (!Number.isSafeInteger(sats) || sats < MIN_PAYOUT_SATS) return undefined;
  return Math.abs(value * COIN - sats) <= 1e-3 ? sats : undefined;
}
