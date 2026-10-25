import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import type { StarterConfig } from "../src/config";
import { base58Decode, bytesToHex, hexToBytes } from "../src/keys";
import {
  KEY_LIST_STALE_MS,
  KEY_LIST_MISS_REFRESH_MS,
  KEY_LIST_TTL_MS,
  STARTER_MESSAGE_LEN,
  StarterUnavailableError,
  base64Decode,
  buildStarterMessage,
  clearStarterKeyCache,
  getStarterKeys,
  importStarterKey,
  parseStarterKeyList,
  starterTokenHash,
  verifyStarterToken,
} from "../src/starter";

/** The govhub vector (packages/badge/test/vectors/starter-v1.json), copied verbatim. */
const vector = JSON.parse(
  readFileSync(new URL("./vectors/starter-v1.json", import.meta.url), "utf8"),
) as {
  net: "testnet";
  netByte: number;
  issuerId: string;
  epoch: number;
  pubKeyHash: string;
  spki: string;
  keyId: string;
  message: string;
  msgPrefix: string;
  sig: string;
};

const spki = base64Decode(vector.spki);
const msgPrefix = base64Decode(vector.msgPrefix);
const sig = base64Decode(vector.sig);
const fields = {
  network: vector.net,
  issuerId: base58Decode(vector.issuerId),
  pubKeyHash: hexToBytes(vector.pubKeyHash),
};
const key = await importStarterKey(spki, vector.epoch);

function flip(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice();
  out[index] ^= 0x01;
  return out;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

describe("starter vector", () => {
  it("rebuilds the 106-byte message byte for byte", () => {
    const message = buildStarterMessage({ ...fields, keyId: key.keyId, epoch: vector.epoch });
    expect(message.length).toBe(STARTER_MESSAGE_LEN);
    expect(bytesToHex(message)).toBe(vector.message);
    expect(message[17]).toBe(vector.netByte);
  });

  it("derives keyId = SHA-256(spki) locally", () => {
    expect(bytesToHex(key.keyId)).toBe(vector.keyId);
    expect(key.modulusBytes).toBe(256);
  });

  it("verifies the finalized signature", async () => {
    expect(await verifyStarterToken(key, fields, msgPrefix, sig)).toBe(true);
  });

  it("names the token by SHA-256 of its signature", async () => {
    expect(starterTokenHash(sig)).toBe(bytesToHex(sha256(sig)));
    expect(starterTokenHash(sig)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("starter verification rejects", () => {
  it("a tampered msgPrefix", async () => {
    expect(await verifyStarterToken(key, fields, flip(msgPrefix, 0), sig)).toBe(false);
  });

  it("a tampered signature", async () => {
    expect(await verifyStarterToken(key, fields, msgPrefix, flip(sig, 100))).toBe(false);
  });

  it("another epoch under the same key", async () => {
    const other = await importStarterKey(spki, vector.epoch + 1);
    expect(await verifyStarterToken(other, fields, msgPrefix, sig)).toBe(false);
  });

  it("another pubKeyHash (the token pays only its own address)", async () => {
    const pubKeyHash = flip(fields.pubKeyHash, 19);
    expect(await verifyStarterToken(key, { ...fields, pubKeyHash }, msgPrefix, sig)).toBe(false);
  });

  it("another network", async () => {
    expect(
      await verifyStarterToken(key, { ...fields, network: "mainnet" }, msgPrefix, sig),
    ).toBe(false);
  });

  it("another issuer", async () => {
    const issuerId = flip(fields.issuerId, 0);
    expect(await verifyStarterToken(key, { ...fields, issuerId }, msgPrefix, sig)).toBe(false);
  });

  it("s >= n", async () => {
    const atN = bigIntToBytes(key.n, key.modulusBytes);
    expect(await verifyStarterToken(key, fields, msgPrefix, atN)).toBe(false);
    const allOnes = new Uint8Array(key.modulusBytes).fill(0xff);
    expect(await verifyStarterToken(key, fields, msgPrefix, allOnes)).toBe(false);
  });

  it("a signature of the wrong length", async () => {
    expect(await verifyStarterToken(key, fields, msgPrefix, sig.slice(1))).toBe(false);
    const padded = new Uint8Array(sig.length + 1);
    padded.set(sig, 1);
    expect(await verifyStarterToken(key, fields, msgPrefix, padded)).toBe(false);
  });

  it("a msgPrefix that is not 32 bytes", async () => {
    expect(await verifyStarterToken(key, fields, msgPrefix.slice(1), sig)).toBe(false);
  });
});

describe("starter key import", () => {
  async function rsaSpki(modulusLength: number, exponent = [1, 0, 1]): Promise<Uint8Array> {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength,
        publicExponent: new Uint8Array(exponent),
        hash: "SHA-384",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  }

  it("refuses moduli other than 2048 or 3072 bits", async () => {
    await expect(importStarterKey(await rsaSpki(1024), 1)).rejects.toThrow(/1024 bits/);
  });

  it("refuses an exponent other than 65537", async () => {
    await expect(importStarterKey(await rsaSpki(2048, [3]), 1)).rejects.toThrow(/65537/);
  });
});

describe("issuer key list", () => {
  const issuer: StarterConfig = {
    network: "testnet",
    issuerId: vector.issuerId,
    issuerUrl: "https://issuer.test",
  };
  const info = (keys: unknown[], over: Record<string, unknown> = {}) => ({
    variant: "RSABSSA-SHA384-PSS-Randomized",
    network: "testnet",
    issuerId: vector.issuerId,
    keys,
    ...over,
  });

  it("keeps a key whose keyId matches its spki and drops one that does not", async () => {
    const keys = await parseStarterKeyList(
      info([
        { epoch: vector.epoch, keyId: vector.keyId, spki: vector.spki },
        { epoch: vector.epoch + 1, keyId: "00".repeat(32), spki: vector.spki },
        { epoch: vector.epoch + 2, keyId: vector.keyId, spki: "not base64!" },
      ]),
      issuer,
    );
    expect([...keys.keys()]).toEqual([vector.epoch]);
    expect(bytesToHex(keys.get(vector.epoch)!.keyId)).toBe(vector.keyId);
  });

  it("refuses a list for another network or another starter identity", async () => {
    await expect(parseStarterKeyList(info([], { network: "mainnet" }), issuer)).rejects.toThrow();
    await expect(
      parseStarterKeyList(info([], { issuerId: "11111111111111111111111111111111" }), issuer),
    ).rejects.toThrow();
  });

  describe("cache", () => {
    let calls = 0;
    let up = true;
    const fetcher = (async () => {
      calls += 1;
      if (!up) return new Response("down", { status: 503 });
      return Response.json(
        info([{ epoch: vector.epoch, keyId: vector.keyId, spki: vector.spki }]),
      );
    }) as unknown as typeof fetch;

    beforeEach(() => {
      clearStarterKeyCache();
      calls = 0;
      up = true;
    });

    it("reuses a list for five minutes, then refreshes", async () => {
      const t0 = 1_000_000;
      await getStarterKeys(issuer, { now: t0, fetcher });
      await getStarterKeys(issuer, { now: t0 + KEY_LIST_TTL_MS - 1, fetcher });
      expect(calls).toBe(1);
      await getStarterKeys(issuer, { now: t0 + KEY_LIST_TTL_MS, fetcher });
      expect(calls).toBe(2);
    });

    it("a caller can ask for a younger list (an epoch miss right after a boundary)", async () => {
      const t0 = 3_000_000;
      await getStarterKeys(issuer, { now: t0, fetcher });
      await getStarterKeys(issuer, { now: t0 + KEY_LIST_MISS_REFRESH_MS - 1, fetcher, maxAgeMs: KEY_LIST_MISS_REFRESH_MS });
      expect(calls).toBe(1);
      await getStarterKeys(issuer, { now: t0 + KEY_LIST_MISS_REFRESH_MS, fetcher, maxAgeMs: KEY_LIST_MISS_REFRESH_MS });
      expect(calls).toBe(2);
    });

    it("keeps a stale list for up to an hour while the issuer is down", async () => {
      const t0 = 2_000_000;
      await getStarterKeys(issuer, { now: t0, fetcher });
      up = false;
      const stale = await getStarterKeys(issuer, { now: t0 + KEY_LIST_STALE_MS - 1, fetcher });
      expect(stale.has(vector.epoch)).toBe(true);
      await expect(
        getStarterKeys(issuer, { now: t0 + KEY_LIST_STALE_MS, fetcher }),
      ).rejects.toBeInstanceOf(StarterUnavailableError);
    });

    it("is unavailable when the issuer is down and nothing is cached", async () => {
      up = false;
      await expect(getStarterKeys(issuer, { now: 1, fetcher })).rejects.toBeInstanceOf(
        StarterUnavailableError,
      );
    });
  });
});

describe("base58Decode", () => {
  it("decodes a Platform identifier to its 32 bytes", () => {
    const bytes = base58Decode(vector.issuerId);
    expect(bytes.length).toBe(32);
    // The issuer id sits right after the 17-byte tag and the network byte.
    expect(bytesToHex(bytes)).toBe(vector.message.slice(36, 100));
  });

  it("keeps leading zero bytes", () => {
    expect([...base58Decode("1")]).toEqual([0]);
    expect([...base58Decode("11")]).toEqual([0, 0]);
    expect([...base58Decode("12")]).toEqual([0, 1]);
    expect([...base58Decode("z")]).toEqual([57]);
    expect([...base58Decode("21")]).toEqual([58]);
  });

  it("rejects characters outside the alphabet", () => {
    for (const bad of ["", "0", "O", "I", "l", "abc+"]) {
      expect(() => base58Decode(bad)).toThrow();
    }
  });
});

describe("base64Decode", () => {
  it("accepts standard base64 with or without padding", () => {
    expect([...base64Decode("AQAB")]).toEqual([1, 0, 1]);
    expect([...base64Decode("AQ==")]).toEqual([1]);
    expect([...base64Decode("AQ")]).toEqual([1]);
  });

  it("rejects anything else", () => {
    for (const bad of ["A", "AQ-_", "AQ AB", "AQ===", "*"]) {
      expect(() => base64Decode(bad)).toThrow();
    }
  });
});
