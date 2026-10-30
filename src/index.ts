import { INVALID_CODE, parseCodeField } from "./accounts";
import {
  MN_COLLATERAL_SATS,
  bearerToken,
  hashApiKey,
  looksLikeApiKey,
  parseAmountSats,
} from "./apikeys";
import { mintChallenge, verifyCapToken, verifySolutions } from "./cap";
import {
  Env,
  FaucetConfig,
  ProofTier,
  canEscalate,
  capTier,
  resolveConfig,
  toDash,
} from "./config";
import { describeError } from "./errors";
import { hashInvitationSignal, invitationDevice } from "./invitation";
import { AddressError, addressToPubKeyHash } from "./keys";
import {
  clientIp,
  errorJson,
  readJsonObject,
  json,
  preflight,
  rawClientIp,
  verifyTurnstile,
} from "./http";
import { invitationTreasury, treasury } from "./durable";
import { handlePortal } from "./portal";
import { type InvitationIssueResult, type PayoutResult } from "./treasury";

// Only the Durable Object class may be re-exported here: workerd validates the
// entry module's named exports and rejects anything that is not a handler or a
// class, so constants have to live in the module that defines them.
export { InvitationTreasury, Treasury } from "./treasury";



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
function capEndpoint(request: Request, path: string): string {
  return `https://${new URL(request.url).host}${path}`;
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  const device = cfg.invitations.enabled
    ? invitationDevice(request, cfg.invitations.secret)
    : undefined;

  let snap: Awaited<ReturnType<ReturnType<typeof treasury>["snapshot"]>>;
  try {
    snap = await treasury(env).snapshot();
  } catch (err) {
    return json(
      { status: "error", error: describeError(err) },
      503,
    );
  }

  let invitationSnap: typeof snap | undefined;
  let invitationError: string | undefined;
  if (cfg.invitations.enabled) {
    try {
      invitationSnap = await invitationTreasury(env).snapshot();
    } catch (err) {
      invitationError = describeError(err);
    }
  }

  const low = snap.balanceSats < cfg.minBalanceSats;
  return json(
    {
      status: low ? "low_balance" : "ok",
      // Field names below match the old Python faucet so existing clients and
      // the dash-faucet skill keep working.
      balance: toDash(snap.balanceSats),
      coreFaucetAmount: toDash(cfg.payoutSats),
      // The soft-tier limit, because that is the tier every client written
      // against this field (the iOS SDK, the dash-faucet skill) actually uses.
      rateLimitPerHour: cfg.rateLimits.soft,
      depositAddress: snap.address,
      blockHeight: snap.blockHeight,
      availableUtxos: snap.availableUtxos,
      // new fields
      network: cfg.network,
      turnstileSiteKey: cfg.turnstileSiteKey,
      // Non-optional in the Swift SDK's Decodable: omitting it makes every
      // native client fail to parse status at all.
      capEndpoint: capEndpoint(request, "/cap/v1/"),
      // Deliberately the name the old Python faucet used: old web clients
      // already understand it, and the Swift SDK ignores unknown keys.
      hardCapEndpoint: capEndpoint(request, "/cap/hard/"),
      // Per-tier hourly ceilings, so the UI can quote the number that applies
      // to it rather than the soft-tier one above.
      rateLimits: cfg.rateLimits,
      balanceSats: snap.balanceSats,
      poolUtxos: snap.poolUtxos,
      // Coins that can pay an mn key's 1000 DASH collateral in one input.
      collateralUtxos: snap.collateralUtxos,
      spentTodaySats: snap.spentToday,
      dailyBudgetSats: cfg.dailyBudgetSats,
      source: snap.source,
      providers: snap.providers,
      dryRun: cfg.dryRun,
      // API keys (`Authorization: Bearer dfk_…`) skip the captcha; see README.
      apiKeysEnabled: cfg.apiKeys.enabled,
      // Where people sign in for their own API key; null when login is off.
      accountUrl: cfg.auth.origin ? `${cfg.auth.origin}/keys` : null,
      keyMaxPerRequest: toDash(cfg.apiKeys.maxPerRequestSats),
      mnCollateralAmount: toDash(MN_COLLATERAL_SATS),
      invitationsEnabled: cfg.invitations.enabled,
      invitationNetwork: cfg.invitations.network,
      invitationAmount: toDash(cfg.invitations.amountSats),
      invitationExpiresIn: Math.floor(cfg.invitations.ttlMs / 1000),
      invitationMaxPerRequest: cfg.invitations.maxPerRequest,
      invitationRateWindow: Math.floor(cfg.invitations.rateWindowMs / 1000),
      invitationInventory: invitationSnap?.invitations ?? {
        available: 0,
        preparing: 0,
        issued: 0,
      },
      ...(invitationSnap
        ? {
            invitationDepositAddress: invitationSnap.address,
            invitationBalance: toDash(invitationSnap.balanceSats),
            invitationBalanceSats: invitationSnap.balanceSats,
          }
        : {}),
      ...(invitationError ? { invitationError } : {}),
    },
    low ? 503 : 200,
    device?.setCookie ? { "Set-Cookie": device.setCookie } : {},
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
  unauthorized: { status: 401, message: "Invalid, expired or revoked API key" },
  code_invalid: { status: 400, message: INVALID_CODE },
  code_used: { status: 400, message: "This code was already redeemed by this address" },
  bad_request: { status: 400, message: "Invalid request" },
  fragmented: {
    status: 503,
    message:
      "No coin large enough for this amount yet; coins must be merged or confirmed first, so try again later",
  },
  error: { status: 500, message: "Internal server error" },
};

/**
 * `escalatable` says a harder proof would raise this client's own ceiling. Only
 * the per-IP limit is escalatable: `budget_exhausted` is the global daily
 * ceiling, and no amount of proof of work moves it — advertising escalation
 * there would burn a minute of the user's CPU for a guaranteed second 429.
 */
function payoutFailure(result: PayoutFailure, escalatable: boolean): Response {
  const { status, message } = PAYOUT_FAILURES[result.code];
  if (result.code === "bad_request") return errorJson(status, result.detail);
  if (result.code === "unauthorized") {
    return errorJson(status, message, {}, { "WWW-Authenticate": "Bearer" });
  }
  const detail = "detail" in result ? result.detail : undefined;
  const retryAfter = "retryAfter" in result ? result.retryAfter : undefined;
  if (retryAfter === undefined) {
    return errorJson(status, message, detail === undefined ? {} : { detailMessage: detail });
  }

  const extra: Record<string, unknown> = { retryAfter };
  if (detail !== undefined) extra.detailMessage = detail;
  if (result.code === "rate_limited" && escalatable) {
    extra.requiresHardCaptcha = true;
  }
  return errorJson(status, message, extra, {
    "Retry-After": String(retryAfter),
  });
}

async function handleCapChallenge(env: Env, tier: "soft" | "hard"): Promise<Response> {
  const cfg = resolveConfig(env);
  if (!cfg.capSecret) {
    return errorJson(503, "Proof-of-work captcha is not configured");
  }
  const params = tier === "hard" ? cfg.hardCapParams : cfg.capParams;
  // Nothing is stored: the token carries its own expiry, its shape and its MAC,
  // so issuing challenges costs no storage and cannot be exhausted — and the
  // tier a solve buys is readable off the token later without any lookup.
  return json(mintChallenge(cfg.capSecret, params));
}

async function handleCapRedeem(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  if (!cfg.capSecret) {
    return errorJson(503, "Proof-of-work captcha is not configured");
  }

  const parsed = await readJsonObject(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { token?: unknown; solutions?: unknown };

  // The challenge shape comes from the token, not from config, so retuning
  // CAP_C/CAP_S/CAP_D cannot invalidate a solve that is already in flight.
  const result = verifySolutions(cfg.capSecret, body.token, body.solutions);
  if (!result.ok) return errorJson(400, result.reason, { success: false });

  // Must be 200: the SDK's postJSON throws on any other status before it ever
  // looks at `success`.
  return json({ success: true, token: result.capToken, expires: result.expiresAt });
}

type CaptchaOutcome =
  | { ok: true; tier: ProofTier }
  | { ok: false; status: number; reason: string };

/**
 * Verify whichever captcha credential the client presented, and report how
 * strong it was.
 *
 * These are two different credentials and must not be interchangeable: the
 * previous code passed `turnstileToken ?? capToken` to Turnstile's siteverify,
 * which could never succeed for a proof-of-work token and would have handed it
 * to a third party on every native request.
 *
 * With no captcha configured at all, both paths fall through as a no-op — the
 * behaviour the old Python faucet had with CAP unset — and get the weakest
 * tier's allowance.
 */
async function verifyCaptcha(
  env: Env,
  cfg: FaucetConfig,
  ip: string,
  body: { turnstileToken?: string; capToken?: string; hardCapToken?: string },
): Promise<CaptchaOutcome> {
  // `hardCapToken` is only an alias old web clients used for the escalated
  // token; it is never the source of truth for the tier. Both fields land in
  // the same verifier and the tier comes from the shape signed into the token,
  // so posting a soft token under the hard name buys nothing.
  const capToken = body.capToken || body.hardCapToken;

  if (capToken) {
    if (!cfg.capSecret) {
      return { ok: false, status: 400, reason: "Proof-of-work captcha is not configured" };
    }
    const check = verifyCapToken(cfg.capSecret, capToken);
    if (!check.ok) return { ok: false, status: 400, reason: check.reason };

    // Burn it here, not after a successful payout. A capToken that survived a
    // rate-limited or underfunded request would be a reusable bypass of the one
    // thing the proof-of-work actually costs.
    const fresh = await treasury(env).consumeCapToken(capToken, check.expiresAt);
    if (!fresh) return { ok: false, status: 400, reason: "Captcha token already used" };
    return { ok: true, tier: capTier(cfg, check.params) };
  }

  if (body.turnstileToken && cfg.turnstileSecret) {
    const outcome = await verifyTurnstile(cfg.turnstileSecret, body.turnstileToken, ip);
    if (!outcome.ok) {
      const reason = outcome.reason ?? "Captcha verification failed";
      return { ok: false, status: 400, reason };
    }
    return { ok: true, tier: "turnstile" };
  }

  if (cfg.turnstileSecret || cfg.capSecret) {
    return { ok: false, status: 400, reason: "Captcha token required" };
  }
  return { ok: true, tier: "soft" };
}

/**
 * Cheap first line of defence, before any work or outbound calls. Per-colo
 * and ephemeral; the Treasury owns the durable limits.
 */
async function edgeLimited(env: Env, key: string): Promise<Response | undefined> {
  if (!env.EDGE_LIMIT || (await env.EDGE_LIMIT.limit({ key })).success) return undefined;
  return errorJson(429, "Rate limit exceeded", { retryAfter: 60 }, { "Retry-After": "60" });
}

/** The recipient's address and pubKeyHash, or the 400 for a bad address. */
async function parseRecipient(
  body: { address?: string },
  cfg: FaucetConfig,
): Promise<{ address: string; pubKeyHash: string } | Response> {
  const address = (body.address ?? "").trim();
  try {
    return { address, pubKeyHash: await addressToPubKeyHash(address, cfg.network) };
  } catch (err) {
    if (err instanceof AddressError) return errorJson(400, err.message);
    throw err;
  }
}

function payoutSuccess(
  result: Extract<PayoutResult, { ok: true }>,
  address: string,
  cfg: FaucetConfig,
): Response {
  return json({
    txid: result.txid,
    amount: toDash(result.satoshis),
    address,
    network: cfg.network,
    replay: result.replay,
    ...(result.keyId ? { keyId: result.keyId } : {}),
    ...(result.codeLabel ? { code: result.codeLabel } : {}),
    ...(result.dryRun ? { dryRun: true } : {}),
    ...(result.accepted.length ? { relays: result.accepted } : {}),
  });
}


async function handleFaucet(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  const ip = clientIp(request);

  const parsed = await readJsonObject(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed as {
    address?: string;
    turnstileToken?: string;
    capToken?: string;
    hardCapToken?: string;
    amount?: unknown;
    /** A redemption code; `promoCode` is the Python faucet's name for it. */
    code?: unknown;
    promoCode?: unknown;
  };
  if (
    [body.address, body.turnstileToken, body.capToken, body.hardCapToken].some(
      (value) => value !== undefined && typeof value !== "string",
    )
  ) {
    return errorJson(400, "Address and captcha tokens must be strings");
  }

  const code = parseCodeField(body.code ?? body.promoCode);
  if (code && "error" in code) return errorJson(400, code.error);

  const token = bearerToken(request);
  if (token !== undefined) {
    if (code) return errorJson(400, "A code cannot be combined with an API key");
    return handleKeyFaucet(env, cfg, ip, token, body);
  }
  if (body.amount !== undefined) {
    return errorJson(400, "amount requires an API key");
  }

  const limited = await edgeLimited(env, ip);
  if (limited) return limited;

  // Address first: it is pure local arithmetic, and checking it before the
  // captcha means a typo costs the user a retry rather than a fresh proof of
  // work (verifying the capToken consumes it).
  const recipient = await parseRecipient(body, cfg);
  if (recipient instanceof Response) return recipient;

  const captcha = await verifyCaptcha(env, cfg, ip, body);
  if (!captcha.ok) {
    return errorJson(
      captcha.status,
      captcha.reason,
      cfg.network === "testnet" && cfg.capSecret && !body.capToken && !body.hardCapToken
        ? { requiresProofOfWork: true }
        : {},
    );
  }

  const result = await treasury(env).payout({
    ...recipient,
    ip,
    tier: captcha.tier,
    ...(code ? { codeKey: code.key } : {}),
  });
  // A code's refusal is about the code; a harder captcha would not change it.
  if (!result.ok) return payoutFailure(result, !code && canEscalate(cfg, captcha.tier));
  return payoutSuccess(result, recipient.address, cfg);
}

/**
 * Payout for an API-key caller: no captcha, no per-IP limit, and an optional
 * `amount` in DASH. Unknown keys are turned away — and charged the edge limit,
 * so this path cannot be used to skip it — before they reach the spending
 * lock; the Treasury re-checks the key, and applies its tier, inside the lock.
 */
async function handleKeyFaucet(
  env: Env,
  cfg: FaucetConfig,
  ip: string,
  token: string,
  body: { address?: string; amount?: unknown },
): Promise<Response> {
  const apiKeyHash = hashApiKey(token);
  if (!looksLikeApiKey(token) || !(await treasury(env).isActiveApiKey(apiKeyHash))) {
    return (await edgeLimited(env, ip)) ?? payoutFailure({ ok: false, code: "unauthorized" }, false);
  }

  let requestedSats: number | undefined;
  if (body.amount !== undefined) {
    requestedSats = parseAmountSats(body.amount);
    if (requestedSats === undefined) {
      return errorJson(400, "amount must be a number of DASH, at least 0.001, with at most 8 decimals");
    }
  }

  const recipient = await parseRecipient(body, cfg);
  if (recipient instanceof Response) return recipient;

  const result = await treasury(env).payout({ ...recipient, ip, apiKeyHash, requestedSats });
  if (!result.ok) return payoutFailure(result, false);
  return payoutSuccess(result, recipient.address, cfg);
}

type InvitationFailure = Extract<InvitationIssueResult, { ok: false }>;

function invitationFailure(result: InvitationFailure): Response {
  switch (result.code) {
    case "rate_limited":
      return errorJson(
        429,
        "This IP or device already received an invitation in the current window",
        { retryAfter: result.retryAfter },
        { "Retry-After": String(result.retryAfter) },
      );
    case "unavailable":
      return errorJson(503, "Invitation inventory is refilling — please try again soon");
    case "platform_unavailable":
      return errorJson(503, "Platform availability check is temporarily unavailable");
    case "error":
      return errorJson(500, "Invitation could not be created", {
        detailMessage: result.detail,
      });
  }
}

async function handleInvitation(request: Request, env: Env): Promise<Response> {
  const cfg = resolveConfig(env);
  if (!cfg.invitations.enabled) return errorJson(404, "Not found");
  if (!cfg.turnstileSecret || !cfg.turnstileSiteKey) {
    return errorJson(503, "Invitation captcha is not configured");
  }

  const parsed = await readJsonObject(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { turnstileToken?: unknown; count?: unknown };

  const max = cfg.invitations.maxPerRequest;
  // `=== undefined`, not `??`: an explicit null is a malformed request.
  const count = body.count === undefined ? 1 : body.count;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > max
  ) {
    return errorJson(400, `count must be an integer from 1 to ${max}`, { max });
  }

  const ip = clientIp(request);
  const limited = await edgeLimited(env, `invite:${ip}`);
  if (limited) return limited;

  const captcha = await verifyTurnstile(
    cfg.turnstileSecret,
    typeof body.turnstileToken === "string" ? body.turnstileToken : undefined,
    rawClientIp(request),
    {
      hostname: new URL(request.url).hostname,
      action: "invitation_faucet",
    },
  );
  if (!captcha.ok) return errorJson(400, captcha.reason ?? "Captcha verification failed");

  const device = invitationDevice(request, cfg.invitations.secret);
  const result = await invitationTreasury(env).issueInvitation({
    ipHash: hashInvitationSignal(cfg.invitations.secret, "ip", ip),
    deviceHash: hashInvitationSignal(cfg.invitations.secret, "device", device.id),
    count,
  });
  if (!result.ok) return invitationFailure(result);

  const first = result.invitations[0];
  return json(
    {
      invitations: result.invitations.map((entry) => ({
        invitation: entry.uri,
        txid: entry.txid,
        expiresAt: entry.expiresAt,
      })),
      count: result.invitations.length,
      requested: count,
      // Single-voucher fields, kept for clients written against the original
      // one-invitation response: they describe the first entry above.
      invitation: first.uri,
      txid: first.txid,
      amount: toDash(cfg.invitations.amountSats),
      expiresAt: first.expiresAt,
      replay: result.replay,
      network: cfg.invitations.network,
    },
    200,
    {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      ...(device.setCookie ? { "Set-Cookie": device.setCookie } : {}),
    },
  );
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
    return handleCapChallenge(env, "soft");
  }
  if (url.pathname === "/cap/hard/challenge" && request.method === "POST") {
    return handleCapChallenge(env, "hard");
  }
  // Redeem is shape-agnostic on purpose: `verifySolutions` grades against the
  // shape the presented token itself commits to, so both tiers share one
  // implementation. The paths stay separate only because `@cap.js/widget`
  // derives `redeem` from the same `data-cap-api-endpoint` as `challenge`.
  if (
    (url.pathname === "/cap/v1/redeem" || url.pathname === "/cap/hard/redeem") &&
    request.method === "POST"
  ) {
    return handleCapRedeem(request, env);
  }
  if (url.pathname === "/api/core-faucet" && request.method === "POST") {
    return handleFaucet(request, env);
  }
  if (url.pathname === "/api/invitation-faucet" && request.method === "POST") {
    return handleInvitation(request, env);
  }
  const portal = await handlePortal(request, env, url);
  if (portal) return portal;
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

  /** Cron: refresh the isolated invitation inventory, then the tDASH pool. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const cfg = resolveConfig(env);
    if (cfg.invitations.enabled) {
      try {
        const invitations = await invitationTreasury(env).maintainInvitations();
        console.log(
          `invitation maintenance: ${invitations.action} — ${invitations.detail}`,
        );
      } catch (err) {
        // The real-DASH actor must not keep the existing tDASH faucet from
        // maintaining its pool when an invitation provider is unavailable.
        console.error(`invitation maintenance failed: ${describeError(err)}`);
      }
    }
    const result = await treasury(env).maintain();
    console.log(`treasury maintenance: ${result.action} — ${result.detail}`);
  },
};
