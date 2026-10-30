/**
 * The signed-in surface: `/auth/*`, `/api/me/*` and `/api/admin/*`.
 *
 * Admin routes take either the operator's bearer token (scripts) or a session
 * belonging to an `AUTH_ADMINS` identity (the `/admin` page). Every cookie-
 * authenticated write also needs the session's CSRF token and our own Origin.
 */
import {
  type CodeKind,
  type CodePatch,
  codeKey,
  generateVoucherCode,
  isEventCode,
} from "./accounts";
import { KEY_TIERS, type KeyTier, bearerToken, digestEquals, hashApiKey } from "./apikeys";
import {
  type Provider,
  type Session,

  checkCsrf,
  clearSessionCookie,
  csrfToken,
  enabledProviders,
  finishLogin,
  isAdminSession,
  loginResponse,
  readSession,
  startLogin,
} from "./auth";
import { COIN, type Env, type FaucetConfig, resolveConfig } from "./config";
import { treasury } from "./durable";
import { errorJson, json, readJsonObject } from "./http";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_VOUCHERS_PER_BATCH = 200;
const MAX_REDEMPTIONS = 100_000;

/** Pages served from the login origin; on any other host they redirect there. */
const PORTAL_PAGES = new Set(["/keys", "/admin", "/keys.html", "/admin.html"]);

function noStore(body: unknown, status = 200): Response {
  return json(body, status, NO_STORE);
}

function toDash(satoshis: number): number {
  return satoshis / COIN;
}

/**
 * `amount` in DASH as whole duffs, or undefined when it is not a usable
 * amount. Anything finer than a duff is a unit mistake, not a request; the
 * floor keeps a typo from building an unrelayable dust output.
 */
export function parseAmountSats(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const sats = Math.round(value * COIN);
  if (!Number.isSafeInteger(sats) || sats < MIN_PAYOUT_SATS) return undefined;
  return Math.abs(value * COIN - sats) <= 1e-3 ? sats : undefined;
}

/** 0.001 DASH: comfortably above dust, below anything anyone asks for. */
const MIN_PAYOUT_SATS = 100_000;

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= 100
    ? value.trim()
    : undefined;
}

/**
 * Handles the request if it belongs to the portal, else returns null so the
 * router carries on.
 */
export async function handlePortal(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const isAuth = path.startsWith("/auth/");
  const isMe = path === "/api/me" || path.startsWith("/api/me/");
  const isAdmin = path.startsWith("/api/admin/");
  if (!isAuth && !isMe && !isAdmin && !PORTAL_PAGES.has(path)) return null;

  const cfg = resolveConfig(env);
  const auth = cfg.auth;

  // Cookies are host-only, so login lives on exactly one host. Compared by
  // host: the zone already upgrades http to https, and `wrangler dev` reports
  // https requests as http.
  if ((isAuth || PORTAL_PAGES.has(path)) && auth.origin && url.host !== new URL(auth.origin).host) {
    return Response.redirect(`${auth.origin}${path}${url.search}`, 302);
  }
  if (PORTAL_PAGES.has(path)) return null;

  if (isAuth) return handleAuth(request, cfg, env, path);
  if (isMe) return handleMe(request, cfg, env, path);
  return handleAdmin(request, cfg, env, path);
}

// --- /auth -----------------------------------------------------------------------

async function handleAuth(request: Request, cfg: FaucetConfig, env: Env, path: string): Promise<Response> {
  const auth = cfg.auth;
  if (path === "/auth/logout" && request.method === "POST") {
    // Logging out needs no CSRF token, but a cross-site page still may not do it.
    if (auth.origin && request.headers.get("Origin") !== auth.origin) {
      return errorJson(403, "Cross-origin request refused");
    }
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": clearSessionCookie(), ...NO_STORE },
    });
  }

  const match = /^\/auth\/(google|github)\/(login|callback)$/.exec(path);
  if (!match || request.method !== "GET") return errorJson(404, "Not found");
  const provider = match[1] as Provider;
  const client = auth[provider];
  if (!client) return errorJson(404, `${provider} sign-in is not configured`);

  const url = new URL(request.url);
  if (match[2] === "login") {
    return startLogin(provider, client, auth, url.searchParams.get("return"));
  }
  const outcome = await finishLogin(provider, client, auth, request);
  if (outcome.ok) await treasury(env).recordLogin(outcome.identity);
  return loginResponse(outcome, auth);
}

// --- /api/me -------------------------------------------------------------------

async function handleMe(request: Request, cfg: FaucetConfig, env: Env, path: string): Promise<Response> {
  const auth = cfg.auth;
  const session = readSession(request, auth);

  if (path === "/api/me" && request.method === "GET") {
    const base = {
      providers: enabledProviders(auth),
      loginOrigin: auth.origin || null,
      emailDomain: auth.emailDomain,
      githubOrg: auth.githubOrg,
      keyTtlDays: Math.round(auth.keyTtlMs / 86_400_000),
      maxKeys: auth.maxKeysPerUser,
      keyMaxPerRequest: toDash(cfg.apiKeys.maxPerRequestSats),
    };
    if (!session) return noStore({ authenticated: false, ...base });
    return noStore({
      authenticated: true,
      ...base,
      user: {
        id: session.id,
        provider: session.provider,
        email: session.email,
        name: session.name,
        login: session.login ?? null,
      },
      admin: isAdminSession(session, auth),
      csrf: csrfToken(session, auth),
      sessionExpiresAt: session.exp,
    });
  }

  if (!session) return errorJson(401, "Sign in first", {}, NO_STORE);
  if (!checkCsrf(request, session, auth)) return errorJson(403, "Missing or invalid CSRF token");
  const store = treasury(env);

  if (path === "/api/me/keys" && request.method === "GET") {
    return noStore({ keys: await store.listApiKeys(session.id) });
  }
  if (path === "/api/me/keys" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const name = body.label === undefined ? "API key" : label(body.label);
    if (!name) return errorJson(400, "label must be a non-empty string of at most 100 characters");
    return issued(await store.issueOwnKey(ownKeyRequest(session, cfg, name)), auth.maxKeysPerUser);
  }

  const rotate = /^\/api\/me\/keys\/([0-9a-f]{12})\/rotate$/.exec(path);
  if (rotate && request.method === "POST") {
    return issued(
      await store.issueOwnKey({ ...ownKeyRequest(session, cfg, ""), replacing: rotate[1] }),
      auth.maxKeysPerUser,
    );
  }

  const revoke = /^\/api\/me\/keys\/([0-9a-f]{12})$/.exec(path);
  if (revoke && request.method === "DELETE") {
    return (await store.revokeApiKey(revoke[1], session.id))
      ? noStore({ revoked: revoke[1] })
      : errorJson(404, "No active key of yours with that id");
  }
  return errorJson(404, "Not found");
}

function ownKeyRequest(session: Session, cfg: FaucetConfig, name: string) {
  const { sid: _sid, exp: _exp, ...who } = session;
  return {
    who,
    label: name,
    maxActive: cfg.auth.maxKeysPerUser,
    ttlMs: cfg.auth.keyTtlMs,
  };
}

function issued(
  result: Awaited<ReturnType<ReturnType<typeof treasury>["issueOwnKey"]>>,
  max: number,
): Response {
  if (result.ok) return noStore({ token: result.token, key: result.key }, 201);
  return result.reason === "limit"
    ? errorJson(409, `You already have ${max} active keys; revoke one first`)
    : errorJson(404, "No active key of yours with that id");
}

// --- /api/admin ------------------------------------------------------------------

type AdminAuth = { ok: true; actor: string } | { ok: false; response: Response };

/**
 * The operator's bearer token, or an admin's session (with CSRF on writes).
 * A presented bearer that is not the admin token is refused outright rather
 * than falling through to the cookie.
 */
function authorizeAdmin(request: Request, cfg: FaucetConfig): AdminAuth {
  const token = bearerToken(request);
  if (token !== undefined) {
    const header = request.headers.get("Authorization") ?? "";
    const valid =
      cfg.apiKeys.adminTokenSha256 !== "" &&
      /^Bearer\s/i.test(header) &&
      digestEquals(hashApiKey(token), cfg.apiKeys.adminTokenSha256);
    return valid
      ? { ok: true, actor: "admin-token" }
      : { ok: false, response: errorJson(401, "Admin token required", {}, { "WWW-Authenticate": "Bearer" }) };
  }
  const session = readSession(request, cfg.auth);
  if (!session || !isAdminSession(session, cfg.auth)) {
    return { ok: false, response: errorJson(401, "Admin sign-in required", {}, NO_STORE) };
  }
  if (!checkCsrf(request, session, cfg.auth)) {
    return { ok: false, response: errorJson(403, "Missing or invalid CSRF token") };
  }
  const handle = session.provider === "github" ? `github:${session.login ?? session.id}` : `google:${session.email}`;
  return { ok: true, actor: handle };
}

async function handleAdmin(request: Request, cfg: FaucetConfig, env: Env, path: string): Promise<Response> {
  // The admin surface does not exist where keys and codes cannot be used.
  if (!cfg.apiKeys.enabled || (!cfg.apiKeys.adminTokenSha256 && !cfg.auth.origin)) {
    return errorJson(404, "Not found");
  }
  const admin = authorizeAdmin(request, cfg);
  if (!admin.ok) return admin.response;

  if (path === "/api/admin/keys" || path.startsWith("/api/admin/keys/")) {
    return handleAdminKeys(request, env, path);
  }
  if (path === "/api/admin/codes" || path.startsWith("/api/admin/codes/")) {
    return handleAdminCodes(request, cfg, env, path, admin.actor);
  }
  return errorJson(404, "Not found");
}

/** Mint (POST), list (GET) and revoke (DELETE …/<id>) any API key. */
async function handleAdminKeys(request: Request, env: Env, path: string): Promise<Response> {
  const store = treasury(env);
  if (path === "/api/admin/keys" && request.method === "GET") {
    return noStore({ keys: await store.listApiKeys() });
  }

  if (path === "/api/admin/keys" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const name = label(body.label);
    const { tier, perDay } = body;
    if (!name) return errorJson(400, "label must be a non-empty string of at most 100 characters");
    if (typeof tier !== "string" || !KEY_TIERS.includes(tier as KeyTier)) {
      return errorJson(400, `tier must be one of: ${KEY_TIERS.join(", ")}`);
    }
    if (
      perDay !== undefined &&
      perDay !== null &&
      !(typeof perDay === "number" && Number.isInteger(perDay) && perDay >= 1)
    ) {
      return errorJson(400, "perDay must be a positive integer or null (unlimited)");
    }
    const created = await store.createApiKey({
      label: name,
      tier: tier as KeyTier,
      perDay: perDay as number | null | undefined,
    });
    return noStore(created, 201);
  }

  const revoke = /^\/api\/admin\/keys\/([0-9a-f]{12})$/.exec(path);
  if (revoke && request.method === "DELETE") {
    return (await store.revokeApiKey(revoke[1]))
      ? noStore({ revoked: revoke[1] })
      : errorJson(404, "No active key with that id");
  }
  return errorJson(404, "Not found");
}

/** `expiresAt` as epoch milliseconds in the future, null to clear, or undefined if invalid. */
function parseExpiry(value: unknown, now: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > now) return value;
  return undefined;
}

function parseMaxRedemptions(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_REDEMPTIONS
    ? value
    : undefined;
}

function codeAmount(value: unknown, cfg: FaucetConfig): number | undefined {
  const sats = parseAmountSats(value);
  return sats !== undefined && sats <= cfg.apiKeys.maxPerRequestSats ? sats : undefined;
}

const AMOUNT_RULE = (cfg: FaucetConfig) =>
  `amount must be a number of DASH from 0.001 to ${toDash(cfg.apiKeys.maxPerRequestSats)}`;

/**
 * - `GET /api/admin/codes` — every code
 * - `POST /api/admin/codes` — `{kind:"event", code, label, amount, maxRedemptions, expiresAt?}`
 *   or `{kind:"voucher", count, label, amount, expiresAt?}` (single-use, generated)
 * - `GET /api/admin/codes/<id>` — one code and its redemptions
 * - `PATCH /api/admin/codes/<id>` — any of `label, amount, maxRedemptions, expiresAt, disabled`
 */
async function handleAdminCodes(
  request: Request,
  cfg: FaucetConfig,
  env: Env,
  path: string,
  actor: string,
): Promise<Response> {
  const store = treasury(env);
  const now = Date.now();

  if (path === "/api/admin/codes" && request.method === "GET") {
    return noStore({ codes: await store.listCodes() });
  }

  if (path === "/api/admin/codes" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const kind = body.kind as CodeKind;
    if (kind !== "event" && kind !== "voucher") return errorJson(400, "kind must be event or voucher");
    const name = label(body.label);
    if (!name) return errorJson(400, "label must be a non-empty string of at most 100 characters");
    const amountSats = codeAmount(body.amount, cfg);
    if (amountSats === undefined) return errorJson(400, AMOUNT_RULE(cfg));
    const expiresAt = body.expiresAt === undefined ? null : parseExpiry(body.expiresAt, now);
    if (expiresAt === undefined) return errorJson(400, "expiresAt must be a future time in epoch milliseconds, or null");

    let codes: string[];
    let maxRedemptions: number;
    if (kind === "event") {
      const display = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (!isEventCode(display)) {
        return errorJson(400, "code must be 4–32 letters, digits or dashes, starting and ending with a letter or digit");
      }
      const max = parseMaxRedemptions(body.maxRedemptions);
      if (max === undefined) return errorJson(400, `maxRedemptions must be an integer from 1 to ${MAX_REDEMPTIONS}`);
      codes = [display];
      maxRedemptions = max;
    } else {
      const count = body.count === undefined ? 1 : body.count;
      if (!(typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= MAX_VOUCHERS_PER_BATCH)) {
        return errorJson(400, `count must be an integer from 1 to ${MAX_VOUCHERS_PER_BATCH}`);
      }
      codes = Array.from({ length: count }, generateVoucherCode);
      maxRedemptions = 1;
    }

    const created = await store.createCodes({
      kind,
      codes,
      label: name,
      amountSats,
      maxRedemptions,
      expiresAt,
      createdBy: actor,
    });
    return created.ok
      ? noStore({ codes: created.codes }, 201)
      : errorJson(409, `A code ${created.conflict} already exists (codes ignore case, spaces and dashes)`);
  }

  const one = /^\/api\/admin\/codes\/([0-9a-f]{12})$/.exec(path);
  if (one && request.method === "GET") {
    const found = await store.getCode(one[1]);
    return found ? noStore(found) : errorJson(404, "No such code");
  }
  if (one && request.method === "PATCH") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const patch: CodePatch = {};
    if (body.label !== undefined) {
      patch.label = label(body.label);
      if (patch.label === undefined) return errorJson(400, "label must be a non-empty string of at most 100 characters");
    }
    if (body.amount !== undefined) {
      patch.amountSats = codeAmount(body.amount, cfg);
      if (patch.amountSats === undefined) return errorJson(400, AMOUNT_RULE(cfg));
    }
    if (body.maxRedemptions !== undefined) {
      patch.maxRedemptions = parseMaxRedemptions(body.maxRedemptions);
      if (patch.maxRedemptions === undefined) {
        return errorJson(400, `maxRedemptions must be an integer from 1 to ${MAX_REDEMPTIONS}`);
      }
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = parseExpiry(body.expiresAt, now);
      if (expiresAt === undefined) return errorJson(400, "expiresAt must be a future time in epoch milliseconds, or null");
      patch.expiresAt = expiresAt;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return errorJson(400, "disabled must be true or false");
      patch.disabled = body.disabled;
    }
    const updated = await store.updateCode(one[1], patch);
    return updated ? noStore({ code: updated }) : errorJson(404, "No such code");
  }
  return errorJson(404, "Not found");
}

/** The normalized key for a `code`/`promoCode` field, or an error message. */
export function parseCodeField(value: unknown): { key: string } | { error: string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 64) return { error: "code must be a string" };
  const key = codeKey(value);
  return key.length >= 4 ? { key } : { error: "Invalid, expired or fully redeemed code" };
}

