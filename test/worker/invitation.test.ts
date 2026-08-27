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

async function prepareInvitation(): Promise<void> {
  expect((await invitationTreasury().maintainInvitations()).action).toBe("minted");
  expect((await invitationTreasury().maintainInvitations()).action).toBe("updated");
}

async function postInvitation(ip = "203.0.113.10", cookie?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "CF-Connecting-IP": ip,
  };
  if (cookie) headers.Cookie = cookie;
  const response = await SELF.fetch("https://faucet.test/api/invitation-faucet", {
    method: "POST",
    headers,
    body: JSON.stringify({ turnstileToken: "turnstile-token" }),
  });
  return {
    response,
    body: (await response.json()) as Record<string, any>,
    cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0],
  };
}

async function ageIssuedInvitation(): Promise<void> {
  await runInDurableObject(invitationTreasury(), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE invitation_inventory SET issued_at = ? WHERE state = 'issued'`,
      Date.now() - 61 * 60_000,
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
  it("mints an asset lock and waits for its ChainLock before offering it", async () => {
    const minted = await invitationTreasury().maintainInvitations();
    expect(minted.action).toBe("minted");
    expect(chain.broadcastAttempts).toHaveLength(2);

    const waiting = await invitationTreasury().snapshot();
    expect(waiting.invitations).toEqual({ available: 0, preparing: 1, issued: 0 });

    const ready = await invitationTreasury().maintainInvitations();
    expect(ready.action).toBe("updated");
    expect((await invitationTreasury().snapshot()).invitations).toEqual({
      available: 1,
      preparing: 0,
      issued: 0,
    });
  });

  it("issues a wallet invitation and idempotently replays it to the same device", async () => {
    await prepareInvitation();

    const first = await postInvitation();
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      amount: 0.003,
      replay: false,
      network: "mainnet",
    });
    expect(first.body.invitation).toMatch(
      /^dashpay:\/\/invite\?assetlocktx=[0-9a-f]{64}&pk=/,
    );
    expect(first.body.invitation).toContain("&islock=null");
    expect(first.cookie).toMatch(/^dash_invite_device=/);
    expect(first.response.headers.get("Cache-Control")).toContain("no-store");

    const replay = await postInvitation("198.51.100.20", first.cookie);
    expect(replay.response.status).toBe(200);
    expect(replay.body.replay).toBe(true);
    expect(replay.body.invitation).toBe(first.body.invitation);
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
    await ageIssuedInvitation();

    const maintenance = await invitationTreasury().maintainInvitations();
    expect(maintenance.action).toBe("updated");
    expect(maintenance.detail).toContain("1 recycled");

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
          `SELECT prospective_identity_id FROM invitation_inventory LIMIT 1`,
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
      invitationAmount: 0.003,
      invitationInventory: { available: 1, preparing: 0, issued: 0 },
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
