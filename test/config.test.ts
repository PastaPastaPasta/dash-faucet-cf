import { describe, expect, it } from "vitest";
import {
  canEscalate,
  capTier,
  resolveConfig,
  resolveInvitationTreasuryConfig,
  type Env,
} from "../src/config";
import { FAUCET } from "./fixtures";

/** The minimum a deployment must set; everything else has a default. */
function env(overrides: Partial<Env> = {}): Env {
  return {
    NETWORK: "testnet",
    PAYOUT_SATS: "100000000",
    RATE_LIMIT_PER_HOUR: "3",
    DAILY_BUDGET_SATS: "20000000000",
    MIN_BALANCE_SATS: "0",
    POOL_MIN: "8",
    POOL_TARGET: "20",
    POOL_UTXO_SATS: "500000000",
    TURNSTILE_SITE_KEY: "",
    FAUCET_WIF: FAUCET.testnet.wif,
    CAP_SECRET: "test-secret",
    ...overrides,
  } as Env;
}

describe("proof tiers", () => {
  it("defaults to the shapes and limits the faucet actually serves", () => {
    const cfg = resolveConfig(env());
    expect(cfg.capParams).toEqual({ c: 100, s: 32, d: 4 });
    expect(cfg.hardCapParams).toEqual({ c: 50, s: 32, d: 6 });
    expect(cfg.rateLimits).toEqual({ soft: 3, turnstile: 10, hard: 25 });
  });

  it("grades a token by the work its shape commits to", () => {
    const cfg = resolveConfig(env());
    expect(capTier(cfg, cfg.capParams)).toBe("soft");
    expect(capTier(cfg, cfg.hardCapParams)).toBe("hard");
    // One notch under the hard shape is still soft, so a near-miss cannot buy
    // the escalated allowance.
    expect(capTier(cfg, { c: 49, s: 32, d: 6 })).toBe("soft");
    // Retuning the hard shape downwards must keep honouring costlier tokens
    // already in flight.
    const cheaper = resolveConfig(env({ CAP_HARD_C: "20", CAP_HARD_D: "6" }));
    expect(capTier(cheaper, { c: 50, s: 32, d: 6 })).toBe("hard");
  });

  it("refuses a hard shape that is not actually harder", () => {
    // Otherwise `capTier` would promote every cheap native solve to the
    // escalated allowance — the one way a soft token could claim the hard tier.
    expect(() => resolveConfig(env({ CAP_HARD_C: "1", CAP_HARD_D: "1" }))).toThrow(
      /must cost more work/,
    );
    expect(() => resolveConfig(env({ CAP_HARD_C: "100", CAP_HARD_D: "4" }))).toThrow(
      /must cost more work/,
    );
  });

  it("still bounds each tier's shape, with the hard tier's own ceiling", () => {
    // The soft shape must stay inside the guard the Swift SDK enforces...
    expect(() => resolveConfig(env({ CAP_D: "6" }))).toThrow(/too expensive/);
    // ...while the hard shape, which no native client is offered, may exceed it
    // but not without limit.
    expect(resolveConfig(env({ CAP_HARD_C: "55", CAP_HARD_D: "6" })).hardCapParams.c).toBe(55);
    expect(() => resolveConfig(env({ CAP_HARD_C: "60", CAP_HARD_D: "6" }))).toThrow(
      /too expensive/,
    );
    expect(() => resolveConfig(env({ CAP_HARD_D: "7" }))).toThrow(/CAP_HARD_D 1\.\.6/);
  });

  it("only advertises escalation when it would raise the client's ceiling", () => {
    const cfg = resolveConfig(env());
    expect(canEscalate(cfg, "soft")).toBe(true);
    expect(canEscalate(cfg, "turnstile")).toBe(true);
    // Already at the top: re-solving buys nothing.
    expect(canEscalate(cfg, "hard")).toBe(false);
    // Nor does it when the hard tier is no more generous...
    const flat = resolveConfig(env({ RATE_LIMIT_HARD_PER_HOUR: "10" }));
    expect(canEscalate(flat, "turnstile")).toBe(false);
    expect(canEscalate(flat, "soft")).toBe(true);
    // ...or when there is no proof-of-work captcha to escalate to at all.
    const noPow = resolveConfig(env({ CAP_SECRET: "" }));
    expect(canEscalate(noPow, "turnstile")).toBe(false);
  });
});

describe("invitation configuration", () => {
  it("is disabled by default and fixes the voucher at 0.003 DASH", () => {
    const cfg = resolveConfig(env());
    expect(cfg.invitations.enabled).toBe(false);
    expect(cfg.invitations.network).toBe("testnet");
    expect(cfg.invitations.amountSats).toBe(300_000);
    expect(cfg.invitations.ttlMs).toBe(60 * 60 * 1000);
    expect(cfg.invitations.rateWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("requires the encryption secret and Turnstile when enabled", () => {
    expect(() => resolveConfig(env({ INVITATIONS_ENABLED: "1" }))).toThrow(
      /INVITATION_SECRET/,
    );
    const cfg = resolveConfig(
      env({
        INVITATIONS_ENABLED: "1",
        INVITATION_SECRET: "secret",
        TURNSTILE_SITE_KEY: "site",
        TURNSTILE_SECRET: "turnstile",
      }),
    );
    expect(cfg.invitations.enabled).toBe(true);
    expect(cfg.invitations.inventoryTarget).toBe(3);
  });

  it("requires and isolates a separate key for cross-network invitations", () => {
    const parallel = {
      INVITATIONS_ENABLED: "1",
      INVITATION_NETWORK: "mainnet",
      INVITATION_SECRET: "secret",
    };
    expect(() => resolveConfig(env(parallel))).toThrow(/INVITATION_FAUCET_WIF/);

    const input = env({
      ...parallel,
      INVITATION_FAUCET_WIF: FAUCET.mainnet.wif,
      INVITATION_PLATFORM_EXPLORER_URL: "https://platform.example",
    });
    const publicConfig = resolveConfig(input);
    expect(publicConfig.network).toBe("testnet");
    expect(publicConfig.wif).toBe(FAUCET.testnet.wif);
    expect(publicConfig.invitations).toMatchObject({
      network: "mainnet",
      platformExplorerUrl: "https://platform.example",
    });

    const invitationConfig = resolveInvitationTreasuryConfig(input);
    expect(invitationConfig.network).toBe("mainnet");
    expect(invitationConfig.wif).toBe(FAUCET.mainnet.wif);
    expect(invitationConfig.providers[0]).toMatchObject({ kind: "hyphen" });
  });
});
