import { mintChallenge, verifyCapToken, verifySolutions } from "./cap";
import { COIN, Env, FaucetConfig, resolveConfig } from "./config";
import { describeError } from "./errors";
import { AddressError, addressToPubKeyHash } from "./keys";
import { clientIp, errorJson, json, preflight, verifyTurnstile } from "./http";
import type { PayoutResult } from "./treasury";

export { Treasury } from "./treasury";

/** One global Treasury instance owns all spending for a deployment. */
const TREASURY_ID = "faucet-v1";

function treasury(env: Env) {
  return env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
}

function toDash(satoshis: number): number {
  return satoshis / COIN;
}

/**
 * Base URL native clients POST the cap.js handshake to.
 *
 * Derived from the incoming request rather than configured, so it is correct on
 * every hostname the Worker answers on without a redeploy — and it satisfies the
 * Swift SDK's `sameRegistrableDomain` guard by construction, since it *is* the
 * host the client already chose to talk to.
 *
 * The scheme is pinned to https rather than mirrored from the request: the SDK
 * refuses a non-https endpoint outright (an http one would leak the redeemed
 * capToken), and `wrangler dev` reports the request URL as http even when it is
 * serving the production hostname. Local clients should address `/cap/v1/`
 * directly rather than following this field.
 */
function capEndpoint(request: Request): string {
  return `https://${new URL(request.url).host}/cap/v1/`;
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);

  let snap: Awaited<ReturnType<ReturnType<typeof treasury>["snapshot"]>>;
  try {
    snap = await treasury(env).snapshot();
  } catch (err) {
    return json(
      { status: "error", error: describeError(err) },
      503,
    );
  }

  const low = snap.balanceSats < cfg.minBalanceSats;
  return json(
    {
      status: low ? "low_balance" : "ok",
      // Field names below match the old Python faucet so existing clients and
      // the dash-faucet skill keep working.
      balance: toDash(snap.balanceSats),
      coreFaucetAmount: toDash(cfg.payoutSats),
      rateLimitPerHour: cfg.rateLimitPerHour,
      depositAddress: snap.address,
      blockHeight: snap.blockHeight,
      availableUtxos: snap.availableUtxos,
      // new fields
      network: cfg.network,
      turnstileSiteKey: cfg.turnstileSiteKey,
      // Non-optional in the Swift SDK's Decodable: omitting it makes every
      // native client fail to parse status at all.
      capEndpoint: capEndpoint(request),
      balanceSats: snap.balanceSats,
      poolUtxos: snap.poolUtxos,
      spentTodaySats: snap.spentToday,
      dailyBudgetSats: cfg.dailyBudgetSats,
      source: snap.source,
      providers: snap.providers,
      dryRun: cfg.dryRun,
    },
    low ? 503 : 200,
  );
}

type PayoutFailure = Extract<PayoutResult, { ok: false }>;

/**
 * Exhaustive by construction: adding a failure code in treasury.ts becomes a
 * compile error here rather than silently falling through to a 500.
 */
const PAYOUT_FAILURES: Record<
  PayoutFailure["code"],
  { status: number; message: string }
> = {
  rate_limited: { status: 429, message: "Rate limit exceeded" },
  budget_exhausted: { status: 429, message: "Faucet daily budget exhausted" },
  insufficient_funds: { status: 503, message: "Faucet has insufficient funds" },
  self_pay: {
    status: 400,
    message: "That is the faucet's own deposit address — send to a wallet you control",
  },
  chain_unavailable: { status: 503, message: "Chain providers unavailable" },
  error: { status: 500, message: "Internal server error" },
};

function payoutFailure(result: PayoutFailure): Response {
  const { status, message } = PAYOUT_FAILURES[result.code];
  if ("retryAfter" in result) {
    return errorJson(
      status,
      message,
      { retryAfter: result.retryAfter },
      { "Retry-After": String(result.retryAfter) },
    );
  }
  return errorJson(status, message, { detailMessage: result.detail });
}

async function handleCapChallenge(env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  if (!cfg.capSecret) {
    return errorJson(503, "Proof-of-work captcha is not configured");
  }
  // Nothing is stored: the token carries its own expiry and MAC, so issuing
  // challenges costs no storage and cannot be exhausted.
  return json(mintChallenge(cfg.capSecret, cfg.capParams));
}

async function handleCapRedeem(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  if (!cfg.capSecret) {
    return errorJson(503, "Proof-of-work captcha is not configured");
  }

  let body: { token?: unknown; solutions?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Request body must be JSON");
  }

  // The challenge shape comes from the token, not from config, so retuning
  // CAP_C/CAP_S/CAP_D cannot invalidate a solve that is already in flight.
  const result = verifySolutions(cfg.capSecret, body.token, body.solutions);
  if (!result.ok) return errorJson(400, result.reason, { success: false });

  // Must be 200: the SDK's postJSON throws on any other status before it ever
  // looks at `success`.
  return json({ success: true, token: result.capToken, expires: result.expiresAt });
}

interface CaptchaRejection {
  status: number;
  reason: string;
}

/**
 * Verify whichever captcha credential the client presented.
 *
 * These are two different credentials and must not be interchangeable: the
 * previous code passed `turnstileToken ?? capToken` to Turnstile's siteverify,
 * which could never succeed for a proof-of-work token and would have handed it
 * to a third party on every native request.
 *
 * With no captcha configured at all, both paths fall through as a no-op — the
 * behaviour the old Python faucet had with CAP unset.
 */
async function verifyCaptcha(
  env: Env,
  cfg: FaucetConfig,
  ip: string,
  body: { turnstileToken?: string; capToken?: string },
): Promise<CaptchaRejection | null> {
  if (body.capToken) {
    if (!cfg.capSecret) {
      return { status: 400, reason: "Proof-of-work captcha is not configured" };
    }
    const check = verifyCapToken(cfg.capSecret, body.capToken);
    if (!check.ok) return { status: 400, reason: check.reason };

    // Burn it here, not after a successful payout. A capToken that survived a
    // rate-limited or underfunded request would be a reusable bypass of the one
    // thing the proof-of-work actually costs.
    const fresh = await treasury(env).consumeCapToken(body.capToken, check.expiresAt);
    if (!fresh) return { status: 400, reason: "Captcha token already used" };
    return null;
  }

  if (body.turnstileToken) {
    const outcome = await verifyTurnstile(cfg.turnstileSecret, body.turnstileToken, ip);
    return outcome.ok
      ? null
      : { status: 400, reason: outcome.reason ?? "Captcha verification failed" };
  }

  if (cfg.turnstileSecret || cfg.capSecret) {
    return { status: 400, reason: "Captcha token required" };
  }
  return null;
}

async function handleFaucet(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  const ip = clientIp(request);

  let body: { address?: string; turnstileToken?: string; capToken?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson(400, "Request body must be JSON");
  }

  // Cheap first line of defence, before any work or outbound calls. Per-colo
  // and ephemeral; the Treasury owns the durable limit.
  if (env.EDGE_LIMIT) {
    const { success } = await env.EDGE_LIMIT.limit({ key: ip });
    if (!success) {
      return errorJson(429, "Rate limit exceeded", { retryAfter: 60 }, {
        "Retry-After": "60",
      });
    }
  }

  // Address first: it is pure local arithmetic, and checking it before the
  // captcha means a typo costs the user a retry rather than a fresh proof of
  // work (verifying the capToken consumes it).
  let pubKeyHash: string;
  const address = (body.address ?? "").trim();
  try {
    pubKeyHash = await addressToPubKeyHash(address, cfg.network);
  } catch (err) {
    if (err instanceof AddressError) return errorJson(400, err.message);
    throw err;
  }

  const rejected = await verifyCaptcha(env, cfg, ip, body);
  if (rejected) return errorJson(rejected.status, rejected.reason);

  const result = await treasury(env).payout({ address, pubKeyHash, ip });
  if (!result.ok) return payoutFailure(result);

  return json({
    txid: result.txid,
    amount: toDash(result.satoshis),
    address,
    network: cfg.network,
    replay: result.replay,
    ...(result.dryRun ? { dryRun: true } : {}),
    ...(result.accepted.length ? { relays: result.accepted } : {}),
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (
    request.method === "OPTIONS" &&
    (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cap/"))
  ) {
    return preflight();
  }
  if (url.pathname === "/health") {
    return json({ status: "healthy" });
  }
  if (url.pathname === "/api/status" && request.method === "GET") {
    return handleStatus(request, env);
  }
  if (url.pathname === "/cap/v1/challenge" && request.method === "POST") {
    return handleCapChallenge(env);
  }
  if (url.pathname === "/cap/v1/redeem" && request.method === "POST") {
    return handleCapRedeem(request, env);
  }
  if (url.pathname === "/api/core-faucet" && request.method === "POST") {
    return handleFaucet(request, env);
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cap/")) {
    return errorJson(404, "Not found");
  }
  // Anything else is the static UI.
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      // Misconfiguration (a missing FAUCET_WIF, say) surfaces here rather than
      // as an opaque runtime exception.
      return errorJson(500, "Internal server error", {
        detailMessage: describeError(err),
      });
    }
  },

  /** Cron: keep the UTXO pool split so bursts cannot stall on mempool limits. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const result = await treasury(env).maintain();
    console.log(`treasury maintenance: ${result.action} — ${result.detail}`);
  },
};
