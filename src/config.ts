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

export type ProviderSpec =
  | {
      kind: "hyphen" | "insight" | "dashrpc" | "dapi";
      /** Origin, no trailing slash. */
      url: string;
      /** Only consulted when no primary provider could answer. */
      fallback?: boolean;
    }
  | {
      /** DAPI on evonodes found at runtime; see `chain/evonodes.ts`. */
      kind: "evonodes";
      network: NetworkName;
      /**
       * `socket` (production) reaches evonode IPs over `cloudflare:sockets`;
       * `fetch` exists so tests can intercept the calls.
       */
      transport: "socket" | "fetch";
    };

export interface Env {
  ASSETS: Fetcher;
  TREASURY: DurableObjectNamespace<Treasury>;
  /** Separate treasury for real-DASH invitation asset locks. */
  INVITATION_TREASURY?: DurableObjectNamespace<Treasury>;
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
  INVITATIONS_ENABLED?: string;
  INVITATION_NETWORK?: string;
  INVITATION_AMOUNT_SATS?: string;
  INVITATION_INVENTORY_TARGET?: string;
  INVITATION_MAX_PER_REQUEST?: string;
  INVITATION_TTL_SECS?: string;
  INVITATION_RATE_WINDOW_SECS?: string;
  PLATFORM_EXPLORER_URL?: string;
  INVITATION_PLATFORM_EXPLORER_URL?: string;
  /** SHA-256 (hex) of the admin bearer token. Blank disables `/api/admin/*`. */
  ADMIN_TOKEN_SHA256?: string;
  KEY_MAX_PER_REQUEST_SATS?: string;
  KEY_RESERVE_SATS?: string;
  MAX_PAYOUT_INPUTS?: string;
  COLLATERAL_COINS?: string;
  /** `fetch` only for tests; production reaches evonodes over sockets. */
  EVONODE_TRANSPORT?: string;
  /** Origin that serves login, `/keys` and `/admin`, e.g. `https://faucet.dashhq.org`. */
  AUTH_ORIGIN?: string;
  /** Google Workspace domain whose verified accounts may sign in. */
  AUTH_EMAIL_DOMAIN?: string;
  /** GitHub organization whose active members may sign in. */
  AUTH_GITHUB_ORG?: string;
  /** Comma-separated `google:<email>` / `github:<numeric id>` identities with admin rights. */
  AUTH_ADMINS?: string;
  /** Lifetime of a self-serve API key, in days. */
  SELF_SERVE_KEY_TTL_DAYS?: string;
  /** Active self-serve keys one person may hold. */
  MAX_KEYS_PER_USER?: string;

  // secrets
  FAUCET_WIF: string;
  TURNSTILE_SECRET?: string;
  CAP_SECRET?: string;
  INVITATION_SECRET?: string;
  INVITATION_FAUCET_WIF?: string;
  /** HMAC key for session and OAuth-state cookies; at least 32 characters. */
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  /** No trailing slash. Empty disables login entirely. */
  origin: string;
  sessionSecret: string;
  emailDomain: string;
  githubOrg: string;
  admins: Set<string>;
  google: OAuthClient | null;
  github: OAuthClient | null;
  keyTtlMs: number;
  maxKeysPerUser: number;
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
  /**
   * Inputs one payout may spend. Signing costs ~0.35 ms per input and the
   * Workers free plan allows ~10 ms of CPU, so a large payout assembled from
   * hundreds of small coins would be killed mid-build. Past this the request
   * fails cleanly and waits for a coin large enough.
   */
  maxPayoutInputs: number;
  /**
   * Coins of at least one masternode collateral (plus fee headroom) the cron
   * keeps on hand by merging small coins, so an `mn` key payout is a single
   * input rather than hundreds. 0 disables consolidation.
   */
  collateralCoins: number;
  auth: AuthConfig;
  apiKeys: {
    /**
     * Testnet only. A key pays without a captcha and an `mn` key pays 1000
     * DASH at a time — fine for tDASH, never acceptable for real money.
     */
    enabled: boolean;
    adminTokenSha256: string;
    /** Sanity cap on one key payout, mostly against duffs/DASH mix-ups. */
    maxPerRequestSats: number;
    /** A key payout may never take the balance below this, so the public faucet keeps working. */
    reserveSats: number;
  };
  invitations: {
    enabled: boolean;
    /** May differ from the ordinary faucet network. */
    network: NetworkName;
    /**
     * Voucher value. Defaults to 0.03 DASH: the protocol floor is 0.003, but
     * released Dash Wallets gate non-contested invitation claims at 0.03, so
     * a smaller voucher cannot be redeemed by anyone today.
     */
    amountSats: number;
    inventoryTarget: number;
    /** Vouchers one request may take at once. */
    maxPerRequest: number;
    ttlMs: number;
    rateWindowMs: number;
    platformExplorerUrl: string;
    secret: string;
  };
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
    // Independent relays and tip sources, so mainnet does not rest on one
    // Core RPC endpoint the way testnet did when trpc forked off at V24.
    { kind: "evonodes", network: "mainnet", transport: "socket" },
  ],
  // No Core JSON-RPC on testnet: trpc.digitalcash.dev stayed on Core v22 and
  // has sat on a dead fork at height 1,577,999 since V24 activated at
  // 1,578,000. A forked node still answers, so it looks healthy, and reading or
  // relaying through it is worse than not having it.
  //
  // DAPI comes from the evonodes themselves, reached by IP over sockets; the
  // DCG seed gateways are only asked when no evonode answered.
  testnet: [
    { kind: "insight", url: "https://insight.testnet.networks.dash.org" },
    { kind: "evonodes", network: "testnet", transport: "socket" },
    { kind: "dapi", url: "https://seed-1.testnet.networks.dash.org:1443", fallback: true },
    { kind: "dapi", url: "https://seed-2.testnet.networks.dash.org:1443", fallback: true },
    { kind: "dapi", url: "https://seed-3.testnet.networks.dash.org:1443", fallback: true },
  ],
};

/** The network's providers, with the evonode transport this deployment uses. */
function providersFor(network: NetworkName, env: Env): ProviderSpec[] {
  const transport = env.EVONODE_TRANSPORT === "fetch" ? "fetch" : "socket";
  return PROVIDERS[network].map((spec) =>
    spec.kind === "evonodes" ? { ...spec, transport } : spec,
  );
}

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

/** Like `int`, but zero is not a meaningful value for this setting. */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = int(name, raw, fallback);
  if (value < 1) throw new Error(`config ${name} must be at least 1`);
  return value;
}

function oauthClient(id: string | undefined, secret: string | undefined): OAuthClient | null {
  const clientId = (id ?? "").trim();
  const clientSecret = (secret ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Login is testnet-only, like the keys it hands out, and needs an origin and
 * a session secret; each provider additionally needs its client credentials.
 * A missing provider is simply not offered — the faucet itself keeps working.
 */
function authConfig(env: Env, network: NetworkName): AuthConfig {
  const origin = (env.AUTH_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (origin && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
    throw new Error(`AUTH_ORIGIN must be an https origin, got ${origin}`);
  }
  const sessionSecret = env.SESSION_SECRET ?? "";
  const usable = network === "testnet" && origin !== "" && sessionSecret.length >= 32;
  const admins = new Set(
    (env.AUTH_ADMINS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const admin of admins) {
    if (!/^(google:[^@\s]+@[^@\s]+|github:\d+)$/.test(admin)) {
      throw new Error(`AUTH_ADMINS entries must be google:<email> or github:<numeric id>, got ${admin}`);
    }
  }
  return {
    origin: usable ? origin : "",
    sessionSecret: usable ? sessionSecret : "",
    emailDomain: (env.AUTH_EMAIL_DOMAIN ?? "dash.org").trim().toLowerCase(),
    githubOrg: (env.AUTH_GITHUB_ORG ?? "dashpay").trim(),
    admins,
    google: usable ? oauthClient(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET) : null,
    github: usable ? oauthClient(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET) : null,
    keyTtlMs: positiveInt("SELF_SERVE_KEY_TTL_DAYS", env.SELF_SERVE_KEY_TTL_DAYS, 180) * 86_400_000,
    maxKeysPerUser: positiveInt("MAX_KEYS_PER_USER", env.MAX_KEYS_PER_USER, 5),
  };
}

function adminTokenSha256(raw: string | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (value && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("ADMIN_TOKEN_SHA256 must be a hex SHA-256 digest");
  }
  return value;
}

function networkName(name: string, raw: string): NetworkName {
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`${name} must be "mainnet" or "testnet", got ${raw}`);
  }
  return raw;
}

export function resolveConfig(env: Env): FaucetConfig {
  const network = networkName("NETWORK", env.NETWORK);
  if (!env.FAUCET_WIF) {
    throw new Error("FAUCET_WIF secret is not set");
  }

  const invitationsEnabled = env.INVITATIONS_ENABLED === "1";
  const invitationNetwork = networkName(
    "INVITATION_NETWORK",
    env.INVITATION_NETWORK || network,
  );
  const invitationSecret = env.INVITATION_SECRET ?? "";
  if (invitationsEnabled && !invitationSecret) {
    throw new Error("INVITATION_SECRET must be set when invitations are enabled");
  }
  if (
    invitationsEnabled &&
    invitationNetwork !== network &&
    !env.INVITATION_FAUCET_WIF
  ) {
    throw new Error(
      "INVITATION_FAUCET_WIF must be set when the invitation network differs from NETWORK",
    );
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
    providers: providersFor(network, env),
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
    maxPayoutInputs: positiveInt("MAX_PAYOUT_INPUTS", env.MAX_PAYOUT_INPUTS, 20),
    auth: authConfig(env, network),
    collateralCoins: int("COLLATERAL_COINS", env.COLLATERAL_COINS, 0),
    apiKeys: {
      enabled: network === "testnet",
      adminTokenSha256: adminTokenSha256(env.ADMIN_TOKEN_SHA256),
      maxPerRequestSats: positiveInt(
        "KEY_MAX_PER_REQUEST_SATS",
        env.KEY_MAX_PER_REQUEST_SATS,
        5000 * COIN,
      ),
      reserveSats: int("KEY_RESERVE_SATS", env.KEY_RESERVE_SATS, 0),
    },
    invitations: {
      enabled: invitationsEnabled,
      network: invitationNetwork,
      amountSats: positiveInt(
        "INVITATION_AMOUNT_SATS",
        env.INVITATION_AMOUNT_SATS,
        3_000_000,
      ),
      inventoryTarget: int(
        "INVITATION_INVENTORY_TARGET",
        env.INVITATION_INVENTORY_TARGET,
        10,
      ),
      maxPerRequest: positiveInt(
        "INVITATION_MAX_PER_REQUEST",
        env.INVITATION_MAX_PER_REQUEST,
        1,
      ),
      ttlMs: int("INVITATION_TTL_SECS", env.INVITATION_TTL_SECS, 60 * 60) * 1000,
      rateWindowMs:
        int(
          "INVITATION_RATE_WINDOW_SECS",
          env.INVITATION_RATE_WINDOW_SECS,
          7 * 24 * 60 * 60,
        ) * 1000,
      platformExplorerUrl:
        (env.INVITATION_PLATFORM_EXPLORER_URL ??
          env.PLATFORM_EXPLORER_URL ??
          (invitationNetwork === "mainnet"
            ? "https://platform-explorer.pshenmic.dev"
            : "https://testnet.platform-explorer.pshenmic.dev"))
          .replace(/\/+$/, ""),
      secret: invitationSecret,
    },
  };
}

/**
 * Build the configuration used by the isolated invitation Durable Object.
 *
 * The public Worker may remain a testnet DASH faucet while this actor signs
 * mainnet asset locks with a different key and different chain providers.
 */
export function resolveInvitationTreasuryConfig(env: Env): FaucetConfig {
  const config = resolveConfig(env);
  const network = config.invitations.network;
  const wif =
    env.INVITATION_FAUCET_WIF ||
    (network === config.network ? config.wif : "");
  if (!wif) {
    throw new Error("INVITATION_FAUCET_WIF secret is not set");
  }
  return {
    ...config,
    network,
    providers: providersFor(network, env),
    wif,
    // Keys follow the actor's own network: this one may hold real DASH.
    apiKeys: { ...config.apiKeys, enabled: network === "testnet" },
    // Its coins are invitation inventory, never mn collateral.
    collateralCoins: 0,
  };
}

export const COIN = 100_000_000;

export function toDash(satoshis: number): number {
  return satoshis / COIN;
}
