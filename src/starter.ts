/**
 * govhub starter tokens: verification of the blind-signed token and the
 * issuer's key list.
 *
 * A masternode (proved with its voting key) or a proposal (proved with its
 * payment address) gets one starter token from the govhub issuer. The issuer
 * signs it blind (RSABSSA-SHA384-PSS-Randomized, RFC 9474), so neither it nor
 * this faucet can link the masternode or proposal to the address the token
 * later pays. This file is the faucet's own copy of the format in govhub
 * (packages/badge/src/starter.ts); test/vectors/starter-v1.json pins both.
 *
 * Token message, fixed width (106 bytes):
 *   "govhub-starter:v1" || net(1) || issuerId(32) || keyId(32) || epoch(u32 BE) || pubKeyHash(20)
 * RSABSSA's randomized prepare prepends a fresh 32-byte msgPrefix, and the
 * finalized signature is a plain RSASSA-PSS signature (SHA-384, MGF1-SHA-384,
 * salt length 48) over preparedMsg = msgPrefix || message, so WebCrypto can
 * verify it without any blind-RSA library.
 *
 * The faucet rebuilds the message from its own config (network, starter issuer
 * id), the key it accepts for `epoch` (keyId = SHA-256(spki), computed here)
 * and the pubKeyHash of the address it is about to pay. A token seen in transit
 * therefore cannot be redeemed for anyone else's address.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import type { NetworkName, StarterConfig } from "./config";
import { bytesToHex } from "./keys";

const encoder = new TextEncoder();

const STARTER_TAG = encoder.encode("govhub-starter:v1");
export const STARTER_MESSAGE_LEN = STARTER_TAG.length + 1 + 32 + 32 + 4 + 20; // 106
const MSG_PREFIX_LEN = 32;
/** PSS salt length of RSABSSA-SHA384-PSS-*: the SHA-384 digest length. */
const SALT_LEN = 48;
const NET_BYTE: Readonly<Record<NetworkName, number>> = { mainnet: 1, testnet: 2 };
const ALLOWED_MODULUS_BITS = [2048, 3072];
/** Cheap sanity on the modulus, as govhub's reader does (not a primality test). */
const SMALL_PRIMES = [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n, 73n, 79n, 83n, 89n, 97n];
/** base64url of 65537, as JWK `e`. */
const PUBLIC_EXPONENT_B64URL = "AQAB";

/** How long a fetched key list is used without asking the issuer again. */
export const KEY_LIST_TTL_MS = 5 * 60_000;
/**
 * A token whose epoch is not in the cached list triggers one refresh if the
 * list is older than this: right after an epoch boundary the issuer lists a key
 * the cache has not seen yet, and "unknown key" must not be the answer then.
 */
export const KEY_LIST_MISS_REFRESH_MS = 30_000;
/** How long a key list may still be used when refreshing it fails. */
export const KEY_LIST_STALE_MS = 60 * 60_000;
const KEY_LIST_TIMEOUT_MS = 5_000;

// ---- encodings ---------------------------------------------------------------

/** Standard-alphabet base64, padding optional. Throws on anything else. */
export function base64Decode(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error("invalid base64");
  }
  const bare = text.replace(/=+$/, "");
  if (bare.length % 4 === 1) throw new Error("invalid base64 length");
  const binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlToBigInt(text: string): bigint {
  const bytes = base64Decode(text.replace(/-/g, "+").replace(/_/g, "/"));
  return bytesToBigInt(bytes);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- message -----------------------------------------------------------------

export interface StarterFields {
  network: NetworkName;
  /** the starter issuer identity, 32 bytes */
  issuerId: Uint8Array;
  /** SHA-256(spki) of the key that signed */
  keyId: Uint8Array;
  epoch: number;
  /** hash160 of the key the starter pays */
  pubKeyHash: Uint8Array;
}

/** An unsigned 32-bit integer, as an epoch is on the wire. */
export function isU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function buildStarterMessage(f: StarterFields): Uint8Array {
  const net = NET_BYTE[f.network];
  if (net === undefined) throw new Error("unknown network");
  if (!isU32(f.epoch)) throw new Error("epoch must be u32");
  if (f.issuerId.length !== 32) throw new Error("issuerId must be 32 bytes");
  if (f.keyId.length !== 32) throw new Error("keyId must be 32 bytes");
  if (f.pubKeyHash.length !== 20) throw new Error("pubKeyHash must be 20 bytes");
  const epoch = new Uint8Array(4);
  new DataView(epoch.buffer).setUint32(0, f.epoch, false);
  const msg = concat(STARTER_TAG, Uint8Array.of(net), f.issuerId, f.keyId, epoch, f.pubKeyHash);
  if (msg.length !== STARTER_MESSAGE_LEN) throw new Error("bad starter message length");
  return msg;
}

// ---- keys --------------------------------------------------------------------

export interface StarterKey {
  epoch: number;
  /** SHA-256(spki), always computed here, never taken from the issuer. */
  keyId: Uint8Array;
  cryptoKey: CryptoKey;
  modulusBytes: number;
  n: bigint;
}

/**
 * Import an issuer SPKI. Requires e = 65537, an RSA-2048 or RSA-3072 modulus
 * without tiny factors, and canonical DER (a re-export must be byte-identical),
 * so the keyId names exactly one encoding of one key — the one clients bound into their tokens.
 */
export async function importStarterKey(spki: Uint8Array, epoch: number): Promise<StarterKey> {
  const cryptoKey = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", cryptoKey)) as JsonWebKey;
  if (jwk.e !== PUBLIC_EXPONENT_B64URL) throw new Error("public exponent must be 65537");
  if (!jwk.n) throw new Error("missing modulus");
  const n = base64UrlToBigInt(jwk.n);
  const bits = n.toString(2).length;
  if (!ALLOWED_MODULUS_BITS.includes(bits)) throw new Error(`modulus of ${bits} bits not allowed`);
  if (n % 2n === 0n || SMALL_PRIMES.some((p) => n % p === 0n)) {
    throw new Error("modulus has a tiny factor");
  }
  const canonical = new Uint8Array(
    (await crypto.subtle.exportKey("spki", cryptoKey)) as ArrayBuffer,
  );
  if (!equalBytes(canonical, spki)) throw new Error("SPKI is not canonical DER");
  return { epoch, keyId: sha256(spki), cryptoKey, modulusBytes: bits / 8, n };
}

/**
 * Rebuild the message and verify the finalized token signature. Never throws.
 * Length and s < n are checked here rather than left to WebCrypto, matching
 * the reader rules govhub applies to the same signatures.
 */
export async function verifyStarterToken(
  key: StarterKey,
  fields: Omit<StarterFields, "keyId" | "epoch">,
  msgPrefix: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  try {
    if (msgPrefix.length !== MSG_PREFIX_LEN) return false;
    if (sig.length !== key.modulusBytes) return false;
    if (bytesToBigInt(sig) >= key.n) return false;
    const message = buildStarterMessage({ ...fields, keyId: key.keyId, epoch: key.epoch });
    return await crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: SALT_LEN },
      key.cryptoKey,
      sig,
      concat(msgPrefix, message),
    );
  } catch {
    return false;
  }
}

/** The only thing the faucet stores about a token: hex(SHA-256(sig)). */
export function starterTokenHash(sig: Uint8Array): string {
  return bytesToHex(sha256(sig));
}

// ---- the issuer's key list ---------------------------------------------------
//
// The faucet takes its keys from the issuer's /v1/starter/info rather than
// proving the issuerKey documents on Platform itself. That is safe here:
//  - key tagging is the threat proofs defend against, and it is the client's
//    side that matters. A browser blinds only against the key it proved from
//    Platform, so whatever list the faucet is served cannot single anyone out:
//    a token made under any other key simply fails to verify here.
//  - the issuer can mint valid tokens at will anyway, so trusting its list
//    gives it no power it does not already have.
//  - one operator runs both services. The daily budget bounds the loss if the
//    issuer, or its key, is ever compromised.

export class StarterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarterUnavailableError";
  }
}

/**
 * Validate an issuer's /v1/starter/info body and import its keys. The network
 * and issuer must be exactly this faucet's; each keyId is recomputed from its
 * spki, and an entry that disagrees, or whose key is unacceptable, is dropped.
 */
export async function parseStarterKeyList(
  info: unknown,
  expected: StarterConfig,
): Promise<Map<number, StarterKey>> {
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    throw new Error("issuer info is not an object");
  }
  const body = info as { network?: unknown; issuerId?: unknown; keys?: unknown };
  if (body.network !== expected.network) throw new Error("issuer serves another network");
  if (body.issuerId !== expected.issuerId) throw new Error("issuer serves another starter identity");
  if (!Array.isArray(body.keys)) throw new Error("issuer info has no key list");

  const keys = new Map<number, StarterKey>();
  for (const entry of body.keys as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const { epoch, keyId, spki } = entry as { epoch?: unknown; keyId?: unknown; spki?: unknown };
    if (
      !isU32(epoch) ||
      typeof keyId !== "string" ||
      !/^[0-9a-f]{64}$/.test(keyId) ||
      typeof spki !== "string" ||
      keys.has(epoch)
    ) {
      continue;
    }
    try {
      const key = await importStarterKey(base64Decode(spki), epoch);
      if (bytesToHex(key.keyId) !== keyId) continue;
      keys.set(epoch, key);
    } catch {
      // An unacceptable key is simply not offered.
    }
  }
  return keys;
}

interface CachedKeys {
  keys: Map<number, StarterKey>;
  fetchedAt: number;
}

/** Per isolate, per issuer. A cold isolate fetches once. */
const keyCache = new Map<string, CachedKeys>();

/** Tests only. */
export function clearStarterKeyCache(): void {
  keyCache.clear();
}

async function fetchKeyList(
  issuer: StarterConfig,
  fetcher: typeof fetch,
  now: number,
): Promise<CachedKeys> {
  const res = await fetcher(`${issuer.issuerUrl}/v1/starter/info`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(KEY_LIST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`issuer answered ${res.status}`);
  return { keys: await parseStarterKeyList(await res.json(), issuer), fetchedAt: now };
}

/**
 * The keys the faucet accepts, by epoch. Fresh for KEY_LIST_TTL_MS; when a
 * refresh fails, a list up to KEY_LIST_STALE_MS old keeps being used, after
 * which the faucet reports itself unavailable rather than guess.
 */
export async function getStarterKeys(
  issuer: StarterConfig,
  opts: { now?: number; fetcher?: typeof fetch; maxAgeMs?: number } = {},
): Promise<Map<number, StarterKey>> {
  const now = opts.now ?? Date.now();
  const cacheKey = `${issuer.network}|${issuer.issuerUrl}|${issuer.issuerId}`;
  const cached = keyCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < (opts.maxAgeMs ?? KEY_LIST_TTL_MS)) return cached.keys;

  // No cross-request de-duplication of the refresh: workerd does not let one
  // request safely await I/O started by another, and a few parallel refreshes
  // at a TTL boundary cost nothing.
  try {
    const fresh = await fetchKeyList(issuer, opts.fetcher ?? fetch, now);
    keyCache.set(cacheKey, fresh);
    return fresh.keys;
  } catch {
    if (cached && now - cached.fetchedAt < KEY_LIST_STALE_MS) return cached.keys;
    throw new StarterUnavailableError("starter issuer key list is unavailable");
  }
}
