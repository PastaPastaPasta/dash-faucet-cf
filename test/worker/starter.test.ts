import {
  SELF,
  createScheduledController,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58Decode, bytesToHex, hexToBytes } from "../../src/keys";
import { buildStarterMessage } from "../../src/starter";
import { STARTER_TREASURY_ID, STATUS_SNAPSHOT_TTL_MS } from "../../src/treasury";
import { FAUCET, RECIPIENT } from "../fixtures";
import { FakeChain } from "./fakechain";

const chain = new FakeChain();

// Match vitest.config.ts.
const ISSUER_URL = "https://issuer.test";
const ISSUER_ID = "9Jwa6v2Bwj9TtDmgJGn3KV9qqXprYZUBEkKzkxzx3HD8";
const AMOUNT = 600_000;
const BUDGET_STARTERS = 3; // STARTER_DAILY_BUDGET_SATS / STARTER_AMOUNT_SATS
const ADDRESS = RECIPIENT.testnet.address;
const PKH = RECIPIENT.testnet.pubKeyHash;

interface IssuerKey {
  epoch: number;
  privateKey: CryptoKey;
  keyId: Uint8Array;
  spki: string;
}

interface Token {
  epoch: number;
  msgPrefix: string;
  sig: string;
}

const starterTreasury = () => {
  const namespace = env.STARTER_TREASURY_TESTNET!;
  return namespace.get(namespace.idFromName(STARTER_TREASURY_ID));
};

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function issuerKey(epoch: number): Promise<IssuerKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-384",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  return { epoch, privateKey: pair.privateKey, keyId: sha256(spki), spki: b64(spki) };
}

function info(keys: IssuerKey[], over: Record<string, unknown> = {}) {
  return {
    variant: "RSABSSA-SHA384-PSS-Randomized",
    network: "testnet",
    issuerId: ISSUER_ID,
    contractId: "2aYj4Dkix7xXBUTZFCDBjpcqqLi9Tg5oUwBgHUJBNGCU",
    height: 1_000,
    issuingEpochs: keys.map((k) => k.epoch),
    ready: true,
    keys: keys.map((k) => ({ epoch: k.epoch, keyId: bytesToHex(k.keyId), spki: k.spki })),
    challengeTtlSec: 1800,
    ...over,
  };
}

/**
 * What the browser ends up holding after blind issuance: RSABSSA's finalized
 * signature is a plain RSASSA-PSS (SHA-384, salt 48) signature over
 * msgPrefix || message, so signing that directly yields an identical token.
 */
async function mint(
  key: IssuerKey,
  opts: { pubKeyHash?: string; network?: "mainnet" | "testnet"; issuerId?: string } = {},
): Promise<Token> {
  const msgPrefix = crypto.getRandomValues(new Uint8Array(32));
  const message = buildStarterMessage({
    network: opts.network ?? "testnet",
    issuerId: base58Decode(opts.issuerId ?? ISSUER_ID),
    keyId: key.keyId,
    epoch: key.epoch,
    pubKeyHash: hexToBytes(opts.pubKeyHash ?? PKH),
  });
  const prepared = new Uint8Array(32 + message.length);
  prepared.set(msgPrefix);
  prepared.set(message, 32);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 48 }, key.privateKey, prepared),
  );
  return { epoch: key.epoch, msgPrefix: b64(msgPrefix), sig: b64(sig) };
}

let ipSeq = 0;
async function redeem(token: Token | Record<string, unknown>, over: Record<string, unknown> = {}) {
  // A fresh IP per request keeps the shared EDGE_LIMIT out of the way.
  ipSeq += 1;
  const response = await SELF.fetch("https://faucet.test/api/starter", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": `198.18.${ipSeq >> 8}.${ipSeq & 255}`,
    },
    body: JSON.stringify({ network: "testnet", address: ADDRESS, ...token, ...over }),
  });
  return { response, body: (await response.json()) as Record<string, any> };
}

function broadcastHexes(): string[] {
  return chain.broadcastAttempts.map((body) => {
    const parsed = JSON.parse(body);
    return parsed.rawtx ?? parsed.params[0];
  });
}

/** An 8-byte little-endian amount followed by the P2PKH script, as in a tx output. */
function p2pkhOutput(satoshis: number, pubKeyHash: string): string {
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, BigInt(satoshis), true);
  return `${bytesToHex(amount)}1976a914${pubKeyHash}88ac`;
}

async function rows() {
  return runInDurableObject(starterTreasury(), (_instance, state) =>
    state.storage.sql
      .exec<{ token_hash: string; txid: string; built_json: string | null; paid: number }>(
        `SELECT * FROM starter_redemptions`,
      )
      .toArray(),
  );
}

let k1: IssuerKey;
let k2: IssuerKey;

beforeAll(async () => {
  [k1, k2] = await Promise.all([issuerKey(2743), issuerKey(2744)]);
});

beforeEach(async () => {
  await runInDurableObject(starterTreasury(), (instance, state) => {
    // the status snapshot cache lives in the instance, which outlives a test
    (instance as unknown as { statusCache: unknown }).statusCache = null;
    for (const table of [
      "starter_redemptions",
      "claims",
      "ip_hits",
      "spent",
      "pending",
      "budget",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  chain.coins = [{ txid: "e".repeat(64), vout: 0, satoshis: 100_000_000 }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.utxoReads.length = 0;
  chain.issuerFetches.length = 0;
  chain.issuers.clear();
  chain.issuers.set(ISSUER_URL, info([k1, k2]));
  chain.install();
});

afterEach(() => {
  env.STARTER_ISSUER_URL_TESTNET = ISSUER_URL;
  env.STARTER_NETWORKS = "testnet";
});

describe("POST /api/starter", () => {
  it("pays STARTER_AMOUNT_SATS to the token's address", async () => {
    const { response, body } = await redeem(await mint(k1));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      amount: AMOUNT / 1e8,
      amountSats: AMOUNT,
      address: ADDRESS,
      network: "testnet",
      replay: false,
    });
    expect(body.txid).toMatch(/^[0-9a-f]{64}$/);

    const hexes = broadcastHexes();
    expect(hexes.length).toBeGreaterThan(0);
    expect(new Set(hexes).size).toBe(1);
    expect(hexes[0]).toContain(p2pkhOutput(AMOUNT, PKH));
    // Paid from the starter key, never the tDASH faucet's.
    expect(hexes[0]).not.toContain(`76a914${FAUCET.testnet.pubKeyHash}88ac`);
  });

  it("replays the same txid for a repeated token without broadcasting again", async () => {
    const token = await mint(k2);
    const first = await redeem(token);
    expect(first.response.status).toBe(200);
    const attempts = chain.broadcastAttempts.length;

    const second = await redeem(token);
    expect(second.response.status).toBe(200);
    expect(second.body.txid).toBe(first.body.txid);
    expect(second.body.replay).toBe(true);
    expect(chain.broadcastAttempts.length).toBe(attempts);
  });

  it("rejects a tampered or misbound token as invalid-token", async () => {
    const token = await mint(k1);
    const sig = Uint8Array.from(atob(token.sig), (c) => c.charCodeAt(0));
    sig[10] ^= 1;
    const prefix = Uint8Array.from(atob(token.msgPrefix), (c) => c.charCodeAt(0));
    prefix[0] ^= 1;

    const cases = [
      { ...token, sig: b64(sig) },
      { ...token, msgPrefix: b64(prefix) },
      // Signed for another address: a token seen in transit pays nobody else.
      await mint(k1, { pubKeyHash: "11".repeat(20) }),
      // Signed for mainnet, presented on testnet.
      await mint(k1, { network: "mainnet" }),
      // Signed for another starter identity.
      await mint(k1, { issuerId: "11111111111111111111111111111111" }),
      // Presented under another epoch's key.
      { ...token, epoch: k2.epoch },
    ];
    for (const bad of cases) {
      const { response, body } = await redeem(bad);
      expect(response.status).toBe(400);
      expect(body.code).toBe("invalid-token");
    }
    expect(chain.broadcastAttempts).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects an epoch the issuer does not list as unknown-key", async () => {
    const stray = await issuerKey(9999);
    const { response, body } = await redeem(await mint(stray));
    expect(response.status).toBe(400);
    expect(body.code).toBe("unknown-key");
  });

  it("drops a listed key whose keyId does not match its spki", async () => {
    const origin = "https://issuer-mismatch.test";
    env.STARTER_ISSUER_URL_TESTNET = origin;
    const listed = info([k1]);
    listed.keys[0].keyId = "00".repeat(32);
    chain.issuers.set(origin, listed);

    const { response, body } = await redeem(await mint(k1));
    expect(response.status).toBe(400);
    expect(body.code).toBe("unknown-key");
  });

  it("refuses a key list served for another starter identity", async () => {
    const origin = "https://issuer-other.test";
    env.STARTER_ISSUER_URL_TESTNET = origin;
    chain.issuers.set(origin, info([k1], { issuerId: "11111111111111111111111111111111" }));

    const { response, body } = await redeem(await mint(k1));
    expect(response.status).toBe(503);
    expect(body.code).toBe("unavailable");
  });

  it("answers 404 disabled for a network that is not enabled", async () => {
    for (const network of ["mainnet", "regtest", 7]) {
      const { response, body } = await redeem(await mint(k1), { network });
      expect(response.status).toBe(404);
      expect(body.code).toBe("disabled");
    }
    expect(chain.issuerFetches).toHaveLength(0);
  });

  it("validates the body before any outbound work", async () => {
    const token = await mint(k1);
    const cases: Array<Record<string, unknown>> = [
      { ...token, epoch: "2743" },
      { ...token, epoch: -1 },
      { ...token, epoch: 1.5 },
      { ...token, sig: undefined },
      { ...token, sig: "not base64!" },
      { ...token, msgPrefix: b64(new Uint8Array(31)) },
      { ...token, address: 12 },
      { ...token, address: RECIPIENT.mainnet.address },
      { ...token, address: "" },
    ];
    for (const bad of cases) {
      const { response, body } = await redeem(bad);
      expect(response.status).toBe(400);
      expect(body.code).toBe("bad-request");
    }
    for (const raw of ["null", "[]", "\"text\"", "{"]) {
      const response = await SELF.fetch("https://faucet.test/api/starter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("bad-request");
    }
    expect(chain.issuerFetches).toHaveLength(0);
    expect(chain.broadcastAttempts).toHaveLength(0);
  });

  it("is unavailable when the issuer cannot be reached and nothing is cached", async () => {
    env.STARTER_ISSUER_URL_TESTNET = "https://issuer-down.test";
    const { response, body } = await redeem(await mint(k1));
    expect(response.status).toBe(503);
    expect(body.code).toBe("unavailable");
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("starter broadcast settlement", () => {
  it("finishes an ambiguous broadcast with the same bytes and pays once", async () => {
    const token = await mint(k1);
    chain.broadcast = { kind: "silence" };
    const logged = vi.spyOn(console, "error");
    const first = await redeem(token);
    expect(first.response.status).toBe(503);
    expect(first.body.code).toBe("unavailable");

    // The token is taken, with the signed bytes kept for the retry.
    const pending = await rows();
    expect(pending).toHaveLength(1);
    expect(pending[0].paid).toBe(0);
    expect(pending[0].built_json).toBeTruthy();
    // The in-flight payout already counts against the daily budget.
    expect((await starterTreasury().snapshot()).spentToday).toBe(AMOUNT);
    // And its txid stays out of the logs.
    const lines = logged.mock.calls.map((c) => c.join(" ")).join("\n");
    logged.mockRestore();
    expect(lines).toContain("<starter payout>");
    expect(lines).not.toContain(pending[0].txid);

    chain.broadcast = { kind: "accept" };
    const retry = await redeem(token);
    expect(retry.response.status).toBe(200);
    expect(retry.body.txid).toBe(pending[0].txid);
    expect(retry.body.replay).toBe(true);

    // Every attempt carried the identical transaction: one payment.
    expect(new Set(broadcastHexes()).size).toBe(1);
    const settled = await rows();
    expect(settled).toEqual([
      { token_hash: pending[0].token_hash, txid: pending[0].txid, built_json: null, paid: 1 },
    ]);

    const attempts = chain.broadcastAttempts.length;
    const again = await redeem(token);
    expect(again.body.txid).toBe(pending[0].txid);
    expect(chain.broadcastAttempts.length).toBe(attempts);
    expect((await starterTreasury().snapshot()).spentToday).toBe(AMOUNT);
  });

  it("treats a stored tx as paid when relays reject it but the chain has it", async () => {
    const token = await mint(k1);
    chain.broadcast = { kind: "silence" };
    expect((await redeem(token)).response.status).toBe(503);
    const [row] = await rows();

    // Mined meanwhile: relays now say its inputs are gone, explorers know it.
    chain.broadcast = { kind: "reject", message: "bad-txns-inputs-missingorspent" };
    chain.known.add(row.txid);
    const retry = await redeem(token);
    expect(retry.response.status).toBe(200);
    expect(retry.body.txid).toBe(row.txid);
    expect(new Set(broadcastHexes()).size).toBe(1);
  });

  it("never replaces an unresolved payout from other coins", async () => {
    // A small coin the first payout takes, and a big one a fresh build would.
    chain.coins = [
      { txid: "e".repeat(64), vout: 0, satoshis: 1_000_000 },
      { txid: "f".repeat(64), vout: 0, satoshis: 100_000_000 },
    ];
    const token = await mint(k1);
    chain.broadcast = { kind: "silence" };
    expect((await redeem(token)).response.status).toBe(503);
    const [row] = await rows();

    // The payout may have been mined and its coin spent, yet the explorers do
    // not know the txid (a lagging index, a node without txindex). That is not
    // proof it is absent, so the token must not be paid again from "f".
    chain.coins = [{ txid: "f".repeat(64), vout: 0, satoshis: 100_000_000 }];
    chain.broadcast = { kind: "reject", message: "bad-txns-inputs-missingorspent" };
    const retry = await redeem(token);
    expect(retry.response.status).toBe(503);
    expect(retry.body.code).toBe("unavailable");
    expect(await rows()).toEqual([row]);
    for (const hex of broadcastHexes()) expect(hex).not.toContain("f".repeat(64));
  });

  it("rebuilds a rejected payout only from its own unspent inputs", async () => {
    chain.coins = [
      { txid: "e".repeat(64), vout: 0, satoshis: 1_000_000 },
      { txid: "f".repeat(64), vout: 0, satoshis: 100_000_000 },
    ];
    const token = await mint(k1);
    chain.broadcast = { kind: "silence" };
    expect((await redeem(token)).response.status).toBe(503);

    // Rejected and unknown, but its input "e" is still unspent: a replacement
    // spending "e" conflicts with the original, so at most one can confirm.
    chain.broadcast = { kind: "reject", message: "dust" };
    expect((await redeem(token)).response.status).toBe(503);
    // A rejected replacement keeps the token taken.
    expect(await rows()).toHaveLength(1);

    chain.broadcast = { kind: "accept" };
    const paid = await redeem(token);
    expect(paid.response.status).toBe(200);
    const hexes = broadcastHexes();
    for (const hex of hexes) {
      expect(hex).toContain("e".repeat(64));
      expect(hex).not.toContain("f".repeat(64));
    }
    expect((await rows())[0]).toMatchObject({ txid: paid.body.txid, paid: 1, built_json: null });
    // Reserved once, for the original attempt.
    expect((await starterTreasury().snapshot()).spentToday).toBe(AMOUNT);
  });

  it("still recognises the original once a replacement was stored over it", async () => {
    chain.coins = [
      { txid: "e".repeat(64), vout: 0, satoshis: 1_000_000 },
      { txid: "f".repeat(64), vout: 0, satoshis: 100_000_000 },
    ];
    const token = await mint(k1);
    chain.broadcast = { kind: "silence" };
    expect((await redeem(token)).response.status).toBe(503);
    const [original] = await rows();

    // The original was mined, but a lagging explorer still lists its input and
    // nobody admits to the txid yet: a conflicting replacement is stored.
    chain.broadcast = { kind: "reject", message: "bad-txns-inputs-missingorspent" };
    expect((await redeem(token)).response.status).toBe(503);
    const [replaced] = await rows();
    expect(JSON.parse(replaced.built_json!)).toHaveLength(2);
    // Signatures carry fresh entropy, so the replacement has its own txid.
    expect(replaced.txid).not.toBe(original.txid);

    // The explorers catch up: the token resolves to the transaction that paid.
    chain.known.add(original.txid);
    const paid = await redeem(token);
    expect(paid.response.status).toBe(200);
    expect(paid.body.txid).toBe(original.txid);
    expect(await rows()).toEqual([
      { token_hash: original.token_hash, txid: original.txid, built_json: null, paid: 1 },
    ]);
  });

  it("keeps an unresolved payout's inputs locked past the stale-coin release", async () => {
    chain.broadcast = { kind: "silence" };
    expect((await redeem(await mint(k1))).response.status).toBe(503);
    await runInDurableObject(starterTreasury(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE spent SET created_at = ?`, Date.now() - 25 * 3_600_000);
    });
    // The explorers still list the coin; it must not return to the pool while
    // the token's own payout might yet confirm.
    expect((await starterTreasury().snapshot()).availableUtxos).toBe(0);
  });

  it("settles an unresolved payout from cron, without the client", async () => {
    chain.broadcast = { kind: "silence" };
    expect((await redeem(await mint(k1))).response.status).toBe(503);
    const [row] = await rows();

    chain.broadcast = { kind: "accept" };
    const result = await starterTreasury().maintain();
    expect(result.detail).toContain("1 unresolved starter payout(s) settled");
    expect(await rows()).toEqual([{ ...row, built_json: null, paid: 1 }]);
    expect(new Set(broadcastHexes()).size).toBeGreaterThanOrEqual(1);
  });

  it("leaves the token usable when every relay rejects the payout", async () => {
    const token = await mint(k1);
    chain.broadcast = { kind: "reject", message: "dust" };
    const first = await redeem(token);
    expect(first.response.status).toBe(503);
    expect(first.body.code).toBe("unavailable");
    // Generic text only: no relay or treasury detail reaches the client.
    expect(first.body.detailMessage).toBeUndefined();
    expect(JSON.stringify(first.body)).not.toContain("dust");
    expect(await rows()).toHaveLength(0);
    // The budget reservation was returned.
    expect((await starterTreasury().snapshot()).spentToday).toBe(0);

    chain.broadcast = { kind: "accept" };
    const retry = await redeem(token);
    expect(retry.response.status).toBe(200);
    expect(retry.body.replay).toBe(false);
  });

  it("stops at the daily budget without consuming the token", async () => {
    for (let i = 0; i < BUDGET_STARTERS; i += 1) {
      expect((await redeem(await mint(k1))).response.status).toBe(200);
    }
    const token = await mint(k1);
    const blocked = await redeem(token);
    expect(blocked.response.status).toBe(429);
    expect(blocked.body.code).toBe("budget");
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(await rows()).toHaveLength(BUDGET_STARTERS);

    // A new day: the same token now pays.
    await runInDurableObject(starterTreasury(), (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM budget`);
    });
    const later = await redeem(token);
    expect(later.response.status).toBe(200);
    expect(later.body.replay).toBe(false);
  });
});

describe("starter privacy", () => {
  it("stores only sha256(sig) -> txid: no address, IP, token or timestamp", async () => {
    const token = await mint(k1);
    const { body } = await redeem(token);
    expect(body.txid).toBeTruthy();

    const { columns, stored, claims, ipHits } = await runInDurableObject(
      starterTreasury(),
      (_instance, state) => ({
        columns: state.storage.sql
          .exec<{ name: string }>(`PRAGMA table_info(starter_redemptions)`)
          .toArray()
          .map((c) => c.name),
        stored: state.storage.sql.exec(`SELECT * FROM starter_redemptions`).toArray(),
        claims: state.storage.sql.exec(`SELECT * FROM claims`).toArray(),
        ipHits: state.storage.sql.exec(`SELECT * FROM ip_hits`).toArray(),
      }),
    );
    expect(columns).toEqual(["token_hash", "txid", "built_json", "paid"]);
    expect(claims).toHaveLength(0);
    expect(ipHits).toHaveLength(0);

    const sig = Uint8Array.from(atob(token.sig), (c) => c.charCodeAt(0));
    expect(stored).toEqual([
      { token_hash: bytesToHex(sha256(sig)), txid: body.txid, built_json: null, paid: 1 },
    ]);
    const dump = JSON.stringify(stored);
    for (const secret of [ADDRESS, PKH, token.sig, token.msgPrefix, "198.18."]) {
      expect(dump).not.toContain(secret);
    }
  });
});

describe("starter status and cron", () => {
  it("reports the starter networks, amount and treasury on /api/status", async () => {
    const res = await SELF.fetch("https://faucet.test/api/status");
    const body = (await res.json()) as Record<string, any>;
    expect(body.starter).toMatchObject({
      networks: ["testnet"],
      amount: AMOUNT / 1e8,
      amountSats: AMOUNT,
    });
    const treasury = body.starter.treasuries.testnet;
    expect(treasury.address).toMatch(/^y/);
    expect(treasury.address).not.toBe(body.depositAddress);
    expect(treasury.balanceSats).toBe(100_000_000);
  });

  it("serves status from a 30 s snapshot cache: polling never queues explorer reads behind redemptions", async () => {
    await runInDurableObject(starterTreasury(), (instance) => {
      (instance as unknown as { statusCache: unknown }).statusCache = null;
    });
    const statusAddress = async () =>
      ((await (await SELF.fetch("https://faucet.test/api/status")).json()) as Record<string, any>)
        .starter.treasuries.testnet.address as string;
    chain.utxoReads.length = 0;
    const address = await statusAddress();
    for (let i = 0; i < 4; i += 1) await statusAddress();
    expect(chain.utxoReads.filter((a) => a === address)).toHaveLength(1);
    // past the TTL, the next status refreshes once
    await runInDurableObject(starterTreasury(), (instance) => {
      const t = instance as unknown as { statusCache: { at: number } | null };
      if (t.statusCache) t.statusCache.at -= STATUS_SNAPSHOT_TTL_MS;
    });
    await statusAddress();
    await statusAddress();
    expect(chain.utxoReads.filter((a) => a === address)).toHaveLength(2);
  });

  it("isolates a bad starter setting from status, the faucet and cron", async () => {
    env.STARTER_NETWORKS = "testnet,bogus";
    const res = await SELF.fetch("https://faucet.test/api/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.balanceSats).toBeGreaterThan(0);
    expect(body.starter.networks).toEqual([]);
    expect(body.starter.error).toMatch(/STARTER_NETWORKS/);

    const { response, body: starter } = await redeem(await mint(k1));
    expect(response.status).toBe(503);
    expect(starter.code).toBe("unavailable");
  });

  it("splits the starter pool from cron, after the existing jobs", async () => {
    const invitations = env.INVITATIONS_ENABLED;
    env.INVITATIONS_ENABLED = "0";
    try {
      await worker.scheduled(createScheduledController(), env);
    } finally {
      env.INVITATIONS_ENABLED = invitations;
    }
    const snap = await starterTreasury().snapshot();
    expect(snap.poolUtxos).toBeGreaterThanOrEqual(2);
  });

  it("still runs the starter pool when an earlier cron job throws", async () => {
    const wif = env.FAUCET_WIF;
    env.FAUCET_WIF = "";
    try {
      await expect(
        worker.scheduled(createScheduledController(), env),
      ).rejects.toThrow(/FAUCET_WIF/);
    } finally {
      env.FAUCET_WIF = wif;
    }
    // The starter DO resolves its own config, which needs FAUCET_WIF only for
    // the shared settings; it was constructed earlier in this file.
    const snap = await starterTreasury().snapshot();
    expect(snap.poolUtxos).toBeGreaterThanOrEqual(2);
  });
});
