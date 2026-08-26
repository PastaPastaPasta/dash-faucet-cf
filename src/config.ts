/** Per-network configuration and env parsing. */

import { capWork, type CapParams } from "./cap";
import type { Treasury } from "./treasury";

export type NetworkName = "mainnet" | "testnet";

/**
 * How strong a proof the client presented, in ascending order of cost.
 *
 * - `soft`: the cheap cap.js challenge native clients can afford (~6.5M hashes).
 * - `turnstile`: a real browser challenge. Cheap for the user, expensive to
 *   automate at scale, so it outranks the soft proof of work.
 * - `hard`: the escalated cap.js challenge (~839M hashes), offered to browsers
 *   that have already exhausted their Turnstile allowance.
 */
export type ProofTier = "soft" | "turnstile" | "hard";

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
  CAP_C?: string;
  CAP_S?: string;
  CAP_D?: string;
  RATE_LIMIT_TURNSTILE_PER_HOUR?: string;
  RATE_LIMIT_HARD_PER_HOUR?: string;
  CAP_HARD_C?: string;
  CAP_HARD_S?: string;
  CAP_HARD_D?: string;
  DRY_RUN?: string;

  // secrets
  FAUCET_WIF: string;
  TURNSTILE_SECRET?: string;
  CAP_SECRET?: string;
}

export interface FaucetConfig {
  network: NetworkName;
  providers: ProviderSpec[];
  payoutSats: number;
  /**
   * Hourly per-IP allowance for each proof tier. The hit *count* is global per
   * IP; only the ceiling it is compared against varies, which is what makes a
   * stronger proof buy more requests rather than a separate quota.
   *
   * Every tier still sits under `dailyBudgetSats`. `hard` is deliberately a
   * high-but-finite limit rather than the old faucet's unlimited bypass, so a
   * single IP with a fast machine cannot drain a day's budget in minutes.
   */
  rateLimits: Record<ProofTier, number>;
  dailyBudgetSats: number;
  minBalanceSats: number;
  poolMin: number;
  poolTarget: number;
  poolUtxoSats: number;
  turnstileSiteKey: string;
  turnstileSecret: string;
  /** cap.js proof-of-work challenge shape served to native clients. */
  capParams: CapParams;
  /** Escalated cap.js shape served at `/cap/hard/`. Browser-only. */
  hardCapParams: CapParams;
  /** Blank disables the proof-of-work captcha entirely. */
  capSecret: string;
  wif: string;
  dryRun: boolean;
}

/**
 * Aggregate work cap for the soft tier, mirroring the guard the Swift SDK
 * enforces on the client (`TestnetFaucet.swift`). That check lives on the client
 * to stop a hostile faucet pinning a phone's cores; mirroring it here means a
 * typo in `CAP_D` fails the deploy's first request loudly, instead of silently
 * bricking every native client with a challenge they refuse to even attempt.
 */
const SOFT_MAX_WORK = 64_000_000;
/**
 * Aggregate work cap for the hard tier. No native client is ever offered this
 * shape — it is reached only by a browser that got a 429 and re-solved with
 * `@cap.js/widget`, which runs a WASM solver across a Web Worker pool — so the
 * SDK's 64M guard deliberately does not apply. The bound that remains exists so
 * a fat-fingered `CAP_HARD_D` cannot mint a challenge nobody can finish inside
 * `CHALLENGE_TTL_MS`.
 */
const HARD_MAX_WORK = 1_000_000_000;

/**
 * Read and validate one challenge shape. Per-field bounds are the protocol's
 * (`c,s in 1..256`, `d in 1..6` — `d` is a hex-digit count the PRNG must emit);
 * `maxWork` is the tier's own affordability ceiling.
 */
function capParams(
  prefix: string,
  raw: { c?: string; s?: string; d?: string },
  fallback: CapParams,
  maxWork: number,
): CapParams {
  const params = {
    c: int(`${prefix}_C`, raw.c, fallback.c),
    s: int(`${prefix}_S`, raw.s, fallback.s),
    d: int(`${prefix}_D`, raw.d, fallback.d),
  };
  const inRange = (n: number, lo: number, hi: number) => n >= lo && n <= hi;
  if (!inRange(params.c, 1, 256) || !inRange(params.s, 1, 256) || !inRange(params.d, 1, 6)) {
    throw new Error(
      `${prefix}_C/${prefix}_S must be 1..256 and ${prefix}_D 1..6, ` +
        `got c=${params.c} s=${params.s} d=${params.d}`,
    );
  }
  const work = capWork(params);
  if (work > maxWork) {
    throw new Error(
      `cap challenge too expensive: c=${params.c} d=${params.d} is ${work} expected hashes > ${maxWork}`,
    );
  }
  return params;
}

/**
 * Which tier a capToken with this challenge shape buys.
 *
 * Graded on work rather than an exact parameter match: anything at least as
 * expensive as the configured hard challenge counts as hard, everything else is
 * soft. Retuning `CAP_HARD_*` downwards therefore still honours tokens minted
 * under the old, costlier shape, and retuning upwards only ever demotes — never
 * promotes — a token that is already in flight.
 *
 * This needs no storage and no separate token type: `c/s/d` live inside the
 * challenge token's MAC'd payload, and the capToken carries that token as a
 * prefix, so the difficulty is covered by the signature that makes the token
 * valid at all. A soft token cannot claim the hard tier.
 */
export function capTier(cfg: FaucetConfig, params: CapParams): ProofTier {
  return capWork(params) >= capWork(cfg.hardCapParams) ? "hard" : "soft";
}

/**
 * True when re-solving at the hard tier would actually raise this client's
 * ceiling — the only case where telling the UI to escalate is honest.
 */
export function canEscalate(cfg: FaucetConfig, tier: ProofTier): boolean {
  return (
    tier !== "hard" && cfg.capSecret !== "" && cfg.rateLimits.hard > cfg.rateLimits[tier]
  );
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

  const soft = capParams(
    "CAP",
    { c: env.CAP_C, s: env.CAP_S, d: env.CAP_D },
    { c: 100, s: 32, d: 4 },
    SOFT_MAX_WORK,
  );
  const hard = capParams(
    "CAP_HARD",
    { c: env.CAP_HARD_C, s: env.CAP_HARD_S, d: env.CAP_HARD_D },
    { c: 50, s: 32, d: 6 },
    HARD_MAX_WORK,
  );
  // `capTier` grades a presented token by work, so a hard shape that is not
  // strictly more expensive than the soft one would silently promote every
  // cheap native solve to the escalated allowance. Fail the deploy instead.
  const softWork = capWork(soft);
  const hardWork = capWork(hard);
  if (hardWork <= softWork) {
    throw new Error(
      `CAP_HARD_* must cost more work than CAP_*: ${hardWork} <= ${softWork} expected hashes`,
    );
  }

  return {
    network,
    providers: PROVIDERS[network],
    payoutSats: int("PAYOUT_SATS", env.PAYOUT_SATS),
    rateLimits: {
      soft: int("RATE_LIMIT_PER_HOUR", env.RATE_LIMIT_PER_HOUR, 3),
      turnstile: int(
        "RATE_LIMIT_TURNSTILE_PER_HOUR",
        env.RATE_LIMIT_TURNSTILE_PER_HOUR,
        10,
      ),
      hard: int("RATE_LIMIT_HARD_PER_HOUR", env.RATE_LIMIT_HARD_PER_HOUR, 25),
    },
    dailyBudgetSats: int("DAILY_BUDGET_SATS", env.DAILY_BUDGET_SATS),
    minBalanceSats: int("MIN_BALANCE_SATS", env.MIN_BALANCE_SATS, 0),
    poolMin: int("POOL_MIN", env.POOL_MIN, 8),
    poolTarget: int("POOL_TARGET", env.POOL_TARGET, 20),
    poolUtxoSats: int("POOL_UTXO_SATS", env.POOL_UTXO_SATS),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? "",
    turnstileSecret: env.TURNSTILE_SECRET ?? "",
    capParams: soft,
    hardCapParams: hard,
    capSecret: env.CAP_SECRET ?? "",
    wif: env.FAUCET_WIF,
    dryRun: env.DRY_RUN === "1",
  };
}

export const COIN = 100_000_000;
