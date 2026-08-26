import { COIN, Env, resolveConfig } from "./config";
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

async function handleStatus(env: Env): Promise<Response> {
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

  const captcha = await verifyTurnstile(
    cfg.turnstileSecret,
    body.turnstileToken ?? body.capToken,
    ip,
  );
  if (!captcha.ok) {
    return errorJson(400, captcha.reason ?? "Captcha verification failed");
  }

  let pubKeyHash: string;
  const address = (body.address ?? "").trim();
  try {
    pubKeyHash = await addressToPubKeyHash(address, cfg.network);
  } catch (err) {
    if (err instanceof AddressError) return errorJson(400, err.message);
    throw err;
  }

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

  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    return preflight();
  }
  if (url.pathname === "/health") {
    return json({ status: "healthy" });
  }
  if (url.pathname === "/api/status" && request.method === "GET") {
    return handleStatus(env);
  }
  if (url.pathname === "/api/core-faucet" && request.method === "POST") {
    return handleFaucet(request, env);
  }
  if (url.pathname.startsWith("/api/")) {
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
