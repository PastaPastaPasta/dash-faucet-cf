import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TREASURY_ID } from "../../src/treasury";
import { FAUCET } from "../fixtures";
import { FakeChain } from "./fakechain";

const chain = new FakeChain();
const coreTreasury = () => env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
const invitationTreasury = () => {
  const namespace = env.INVITATION_TREASURY!;
  return namespace.get(namespace.idFromName(TREASURY_ID));
};

async function resetTreasury(): Promise<void> {
  for (const treasury of [coreTreasury(), invitationTreasury()]) {
    await runInDurableObject(treasury, (_instance, state) => {
      for (const table of [
        "claims",
        "ip_hits",
        "spent",
        "pending",
        "budget",
        "used_cap",
        "invitation_hits",
        "invitation_inventory",
      ]) {
        state.storage.sql.exec(`DELETE FROM ${table}`);
      }
    });
  }
}

/** Mint the full inventory target (3 in this config) and ChainLock it. */
async function prepareInvitation(): Promise<void> {
  expect((await invitationTreasury().maintainInvitations()).action).toBe("minted");
  expect((await invitationTreasury().maintainInvitations()).action).toBe("updated");
}

async function postInvitation(
  ip = "203.0.113.10",
  cookie?: string,
  count?: number,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "CF-Connecting-IP": ip,
  };
  if (cookie) headers.Cookie = cookie;
  const response = await SELF.fetch("https://faucet.test/api/invitation-faucet", {
    method: "POST",
    headers,
    body: JSON.stringify({ turnstileToken: "turnstile-token", count }),
  });
  return {
    response,
    body: (await response.json()) as Record<string, any>,
    cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0],
  };
}

/** Push issued vouchers (all, or just one txid) past their reservation. */
async function ageIssuedInvitation(txid?: string): Promise<void> {
  await runInDurableObject(invitationTreasury(), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE invitation_inventory SET issued_at = ?
        WHERE state = 'issued' AND (? IS NULL OR txid = ?)`,
      Date.now() - 61 * 60_000,
      txid ?? null,
      txid ?? null,
    );
  });
}

beforeEach(async () => {
  await resetTreasury();
  chain.coins = [{ txid: "d".repeat(64), vout: 0, satoshis: 1_000_000_000 }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.siteverifyTokens.length = 0;
  chain.siteverifySucceeds = true;
  chain.siteverifyHostname = "faucet.test";
  chain.siteverifyAction = "invitation_faucet";
  chain.platformIdentities.clear();
  env.TURNSTILE_SECRET = "turnstile-secret";
  chain.install();
});

describe("invitation inventory", () => {
  it("mints asset locks up to target and waits for ChainLocks before offering them", async () => {
    const minted = await invitationTreasury().maintainInvitations();
    expect(minted.action).toBe("minted");
    expect(minted.detail).toContain("3 voucher(s)");
    // Two relays per broadcast.
    expect(chain.broadcastAttempts).toHaveLength(6);

    const waiting = await invitationTreasury().snapshot();
    expect(waiting.invitations).toEqual({ available: 0, preparing: 3, issued: 0 });

    const ready = await invitationTreasury().maintainInvitations();
    expect(ready.action).toBe("updated");
    expect((await invitationTreasury().snapshot()).invitations).toEqual({
      available: 3,
      preparing: 0,
      issued: 0,
    });
  });

  it("locks 0.03 DASH per voucher, the floor released wallets will redeem", async () => {
    await prepareInvitation();
    const amounts = await runInDurableObject(invitationTreasury(), (_instance, state) =>
      state.storage.sql
        .exec<{ amount_sats: number; built_json: string }>(
          `SELECT amount_sats, built_json FROM invitation_inventory`,
        )
        .toArray(),
    );
    expect(amounts).toHaveLength(3);
    for (const row of amounts) {
      expect(row.amount_sats).toBe(3_000_000);
      // Two little-endian uint16s: nVersion=3, nType=8, then the exact
      // 3,000,000-duff credit output (0x2dc6c0) on the value-bearing OP_RETURN.
      const { hex } = JSON.parse(row.built_json) as { hex: string };
      expect(hex.startsWith("03000800")).toBe(true);
      expect(hex).toContain("c0c62d0000000000026a00");
    }
  });

  it("issues a wallet invitation, and a fresh one on repeat while the window is off", async () => {
    await prepareInvitation();

    const first = await postInvitation();
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      amount: 0.03,
      count: 1,
      requested: 1,
      replay: false,
      network: "mainnet",
    });
    expect(first.body.invitation).toMatch(
      /^dashpay:\/\/invite\?assetlocktx=[0-9a-f]{64}&pk=/,
    );
    expect(first.body.invitation).toContain("&islock=null");
    expect(first.body.invitations).toEqual([
      { invitation: first.body.invitation, txid: first.body.txid, expiresAt: first.body.expiresAt },
    ]);
    expect(first.cookie).toMatch(/^dash_invite_device=/);
    expect(first.response.headers.get("Cache-Control")).toContain("no-store");

    // No issuance window means no replay: the same device asking again is an
    // operator onboarding the next person, not a lost response.
    const again = await postInvitation("203.0.113.10", first.cookie);
    expect(again.response.status).toBe(200);
    expect(again.body.replay).toBe(false);
    expect(again.body.txid).not.toBe(first.body.txid);
    expect((await invitationTreasury().snapshot()).invitations).toEqual({
      available: 1,
      preparing: 0,
      issued: 2,
    });
  });

  it("hands out up to the configured batch in one request", async () => {
    await prepareInvitation();

    const tooMany = await postInvitation("203.0.113.10", undefined, 4);
    expect(tooMany.response.status).toBe(400);
    expect(tooMany.body.error).toContain("1 to 3");
    expect((await postInvitation("203.0.113.10", undefined, 0)).response.status).toBe(400);

    const batch = await postInvitation("203.0.113.10", undefined, 3);
    expect(batch.response.status).toBe(200);
    expect(batch.body.count).toBe(3);
    expect(batch.body.requested).toBe(3);
    const txids = batch.body.invitations.map((entry: { txid: string }) => entry.txid);
    expect(new Set(txids).size).toBe(3);
    for (const entry of batch.body.invitations) {
      expect(entry.invitation).toMatch(/^dashpay:\/\/invite\?assetlocktx=/);
      expect(entry.expiresAt).toBe(batch.body.expiresAt);
    }
    // Legacy single-voucher fields describe the first entry.
    expect(batch.body.invitation).toBe(batch.body.invitations[0].invitation);
    expect((await invitationTreasury().snapshot()).invitations).toEqual({
      available: 0,
      preparing: 0,
      issued: 3,
    });

    const empty = await postInvitation("203.0.113.10", undefined, 1);
    expect(empty.response.status).toBe(503);
    expect(empty.body.error).toContain("refilling");
  });

  it("returns a short batch rather than nothing when inventory runs low", async () => {
    await prepareInvitation();
    expect((await postInvitation("203.0.113.10", undefined, 2)).response.status).toBe(200);

    const short = await postInvitation("203.0.113.10", undefined, 3);
    expect(short.response.status).toBe(200);
    expect(short.body.count).toBe(1);
    expect(short.body.requested).toBe(3);
    expect(short.body.invitations).toHaveLength(1);
  });

  it("ignores vouchers minted at a different amount and backfills legacy rows", async () => {
    await prepareInvitation();
    await runInDurableObject(invitationTreasury(), (_instance, state) => {
      const ids = state.storage.sql
        .exec<{ id: string }>(`SELECT id FROM invitation_inventory ORDER BY created_at`)
        .toArray();
      // A pre-upgrade 0.003 DASH voucher: no released wallet can redeem it.
      state.storage.sql.exec(
        `UPDATE invitation_inventory SET amount_sats = 300000 WHERE id = ?`,
        ids[0].id,
      );
      // A row written before the column existed.
      state.storage.sql.exec(
        `UPDATE invitation_inventory SET amount_sats = NULL WHERE id = ?`,
        ids[1].id,
      );
    });

    // Maintenance recovers the missing amount from the signed transaction and
    // treats the small voucher as absent, so it mints one replacement.
    const maintenance = await invitationTreasury().maintainInvitations();
    expect(maintenance.action).toBe("minted");
    expect(maintenance.detail).toContain("1 voucher(s)");
    const amounts = await runInDurableObject(invitationTreasury(), (_instance, state) =>
      state.storage.sql
        .exec<{ amount_sats: number | null }>(
          `SELECT amount_sats FROM invitation_inventory ORDER BY created_at`,
        )
        .toArray()
        .map((row) => row.amount_sats),
    );
    expect(amounts).toEqual([300_000, 3_000_000, 3_000_000, 3_000_000]);

    const batch = await postInvitation("203.0.113.10", undefined, 3);
    expect(batch.response.status).toBe(200);
    // Only the two ChainLocked 0.03 vouchers; the third is still preparing.
    expect(batch.body.count).toBe(2);
    expect((await invitationTreasury().snapshot()).invitations).toEqual({
      available: 0,
      preparing: 1,
      issued: 2,
    });
  });

  it("allows another issuance after expiry when the weekly limit is disabled", async () => {
    await prepareInvitation();
    const first = await postInvitation();
    expect(first.response.status).toBe(200);
    await ageIssuedInvitation();
    expect((await invitationTreasury().maintainInvitations()).action).toBe("updated");

    const next = await postInvitation("203.0.113.10", first.cookie);
    expect(next.response.status).toBe(200);
    expect(next.body.replay).toBe(false);
  });

  it("recycles an unclaimed invitation after 60 minutes", async () => {
    await prepareInvitation();
    const first = await postInvitation();
    expect(first.response.status).toBe(200);
    // Reserve the other two so the recycled voucher is the only one available.
    expect((await postInvitation("198.51.100.41", undefined, 2)).body.count).toBe(2);
    await ageIssuedInvitation(first.body.txid);

    // Reserved vouchers do not count toward the target, so the same pass that
    // recycles this one also starts minting replacements for the other two.
    const maintenance = await invitationTreasury().maintainInvitations();
    expect(maintenance.action).toBe("minted");
    expect((await invitationTreasury().snapshot()).invitations).toEqual({
      available: 1,
      preparing: 2,
      issued: 2,
    });

    const next = await postInvitation("198.51.100.40");
    expect(next.response.status).toBe(200);
    expect(next.body.txid).toBe(first.body.txid);
    // Recycling deliberately reissues the same bearer key. After expiry the
    // old and new recipients may race, and the first valid claim wins.
    expect(next.body.invitation).toBe(first.body.invitation);
  });

  it("retires an expired invitation when its prospective identity exists", async () => {
    await prepareInvitation();
    expect((await postInvitation()).response.status).toBe(200);
    await ageIssuedInvitation();

    const identityId = await runInDurableObject(invitationTreasury(), (_instance, state) =>
      state.storage.sql
        .exec<{ prospective_identity_id: string }>(
          `SELECT prospective_identity_id FROM invitation_inventory WHERE state = 'issued'`,
        )
        .toArray()[0].prospective_identity_id,
    );
    chain.platformIdentities.add(identityId);

    const maintenance = await invitationTreasury().maintainInvitations();
    // Retiring it drops the live inventory below target, so this same pass
    // immediately starts its replacement.
    expect(maintenance.action).toBe("minted");
    const row = await runInDurableObject(invitationTreasury(), (_instance, state) =>
      state.storage.sql
        .exec<{ state: string; cipher_hex: string }>(
          `SELECT state, cipher_hex FROM invitation_inventory WHERE state = 'claimed'`,
        )
        .toArray()[0],
    );
    expect(row).toEqual({ state: "claimed", cipher_hex: "" });
  });

  it("keeps the testnet faucet and mainnet invitation treasuries isolated", async () => {
    await prepareInvitation();

    const status = await SELF.fetch("https://faucet.test/api/status");
    const body = (await status.json()) as Record<string, any>;
    expect(body).toMatchObject({
      network: "testnet",
      depositAddress: FAUCET.testnet.address,
      coreFaucetAmount: 0.1,
      invitationNetwork: "mainnet",
      invitationDepositAddress: FAUCET.mainnet.address,
      invitationAmount: 0.03,
      invitationMaxPerRequest: 3,
      invitationRateWindow: 0,
      invitationInventory: { available: 3, preparing: 0, issued: 0 },
    });

    const coreRows = await runInDurableObject(coreTreasury(), (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invitation_inventory`)
        .toArray()[0].n,
    );
    expect(coreRows).toBe(0);
  });
});

describe("invitation request checks", () => {
  it("binds Turnstile tokens to this hostname and invitation action", async () => {
    await prepareInvitation();
    chain.siteverifyHostname = "other.example";
    const wrongHost = await postInvitation();
    expect(wrongHost.response.status).toBe(400);

    chain.siteverifyHostname = "faucet.test";
    chain.siteverifyAction = "core_faucet";
    const wrongAction = await postInvitation();
    expect(wrongAction.response.status).toBe(400);
    expect(wrongAction.body.error).toContain("another request");
    expect(chain.siteverifyTokens).toEqual(["turnstile-token", "turnstile-token"]);
  });
});
