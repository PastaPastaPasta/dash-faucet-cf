/** Per-network configuration and env parsing. */

import type { Treasury } from "./treasury";

export type NetworkName = "mainnet" | "testnet";

export interface ProviderSpec {
  kind: "hyphen" | "insight" | "dashrpc";
  /** Origin, no trailing slash. */
  url: string;
}

export interface Env {
  ASSETS: Fetcher;
  TREASURY: DurableObjectNamespace<Treasury>;
  /** Cloudflare's built-in rate limiter. Optional so tests can omit it. */
  EDGE_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };

  NETWORK: string;
  PAYOUT_SATS: string;
  RATE_LIMIT_PER_HOUR: string;
  DAILY_BUDGET_SATS: string;
  MIN_BALANCE_SATS: string;
  POOL_MIN: string;
  POOL_TARGET: string;
  POOL_UTXO_SATS: string;
  TURNSTILE_SITE_KEY: string;
  DRY_RUN?: string;

  // secrets
  FAUCET_WIF: string;
  TURNSTILE_SECRET?: string;
}

export interface FaucetConfig {
  network: NetworkName;
  providers: ProviderSpec[];
  payoutSats: number;
  rateLimitPerHour: number;
  dailyBudgetSats: number;
  minBalanceSats: number;
  poolMin: number;
  poolTarget: number;
  poolUtxoSats: number;
  turnstileSiteKey: string;
  turnstileSecret: string;
  wif: string;
  dryRun: boolean;
}

/**
 * Read order matters: cheapest/most-reliable first. Broadcast is fanned out to
 * every provider that supports it, so ordering is irrelevant there.
 *
 * Hyphen is mainnet-only and read-only — it has no broadcast route at all
 * (nginx rejects POST, and /api/v1/tx/broadcast is really /api/v1/tx/{txid}).
 */
const PROVIDERS: Record<NetworkName, ProviderSpec[]> = {
  mainnet: [
    { kind: "hyphen", url: "https://hyphen.dash.org" },
    { kind: "insight", url: "https://insight.dash.org" },
    { kind: "dashrpc", url: "https://rpc.digitalcash.dev" },
  ],
  testnet: [
    { kind: "insight", url: "https://insight.testnet.networks.dash.org" },
    { kind: "dashrpc", url: "https://trpc.digitalcash.dev" },
  ],
};

function int(name: string, raw: string | undefined, fallback?: number): number {
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required numeric config: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`config ${name} must be a non-negative integer, got ${raw}`);
  }
  return n;
}

export function resolveConfig(env: Env): FaucetConfig {
  const network = env.NETWORK as NetworkName;
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(`NETWORK must be "mainnet" or "testnet", got ${env.NETWORK}`);
  }
  if (!env.FAUCET_WIF) {
    throw new Error("FAUCET_WIF secret is not set");
  }

  return {
    network,
    providers: PROVIDERS[network],
    payoutSats: int("PAYOUT_SATS", env.PAYOUT_SATS),
    rateLimitPerHour: int("RATE_LIMIT_PER_HOUR", env.RATE_LIMIT_PER_HOUR, 3),
    dailyBudgetSats: int("DAILY_BUDGET_SATS", env.DAILY_BUDGET_SATS),
    minBalanceSats: int("MIN_BALANCE_SATS", env.MIN_BALANCE_SATS, 0),
    poolMin: int("POOL_MIN", env.POOL_MIN, 8),
    poolTarget: int("POOL_TARGET", env.POOL_TARGET, 20),
    poolUtxoSats: int("POOL_UTXO_SATS", env.POOL_UTXO_SATS),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
    turnstileSecret: env.TURNSTILE_SECRET ?? "",
    wif: env.FAUCET_WIF,
    dryRun: env.DRY_RUN === "1",
  };
}

export const COIN = 100_000_000;
