/**
 * The signed-in surface: `/auth/*`, `/api/me/*` and `/api/admin/*`.
 *
 * Admin routes take either the operator's bearer token (scripts) or a session
 * belonging to an `AUTH_ADMINS` identity (the `/admin` page). Every cookie-
 * authenticated write also needs the session's CSRF token and our own Origin.
 */
import { type CodeKind, type CodePatch, generateVoucherCode, isEventCode } from "./accounts";
import {
  KEY_TIERS,
  type KeyTier,
  bearerToken,
  digestEquals,
  hashApiKey,
  parseAmountSats,
} from "./apikeys";
import {
  type Provider,
  type Session,
  adminHandle,
  checkCsrf,
  clearSessionCookie,
  csrfToken,
  enabledProviders,
  finishLogin,
  isAdminSession,
  loginResponse,
  readSession,
  sameOrigin,
  startLogin,
} from "./auth";
import { type Env, type FaucetConfig, resolveConfig, toDash } from "./config";
import { treasury } from "./durable";
import { errorJson, json, readJsonObject } from "./http";
import type { IssueOwnKeyResult } from "./treasury";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_VOUCHERS_PER_BATCH = 200;
const MAX_REDEMPTIONS = 100_000;

/** Pages served from the login origin; on any other host they redirect there. */
const PORTAL_PAGES = new Set(["/keys", "/admin", "/keys.html", "/admin.html"]);

/**
 * Set here rather than in `_headers`: that file does not reliably reach
 * responses a Worker returns from `env.ASSETS.fetch`, and these pages handle
 * sessions and freshly minted keys.
 */
const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

async function portalPage(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

function noStore(body: unknown, status = 200): Response {
  return json(body, status, NO_STORE);
}

const LABEL_RULE = "label must be a non-empty string of at most 100 characters";
const EXPIRY_RULE = "expiresAt must be a future time in epoch milliseconds, or null";
const MAX_REDEMPTIONS_RULE = `maxRedemptions must be an integer from 1 to ${MAX_REDEMPTIONS}`;

function amountRule(cfg: FaucetConfig): string {
  return `amount must be a number of DASH from 0.001 to ${toDash(cfg.apiKeys.maxPerRequestSats)}`;
}

function isIntInRange(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseLabel(value: unknown): string | undefined {
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
  const isAdminApi = path.startsWith("/api/admin/");
  if (!isAuth && !isMe && !isAdminApi && !PORTAL_PAGES.has(path)) return null;

  const cfg = resolveConfig(env);
  const auth = cfg.auth;

  // Cookies are host-only, so login lives on exactly one host. Compared by
  // host: the zone already upgrades http to https, and `wrangler dev` reports
  // https requests as http.
  if ((isAuth || PORTAL_PAGES.has(path)) && auth.origin && url.host !== new URL(auth.origin).host) {
    return Response.redirect(`${auth.origin}${path}${url.search}`, 302);
  }
  if (PORTAL_PAGES.has(path)) return portalPage(request, env);

  if (isAuth) return handleAuth(request, cfg, env, url);
  if (isMe) return handleMe(request, cfg, env, path);
  return handleAdmin(request, cfg, env, path);
}

// --- /auth -----------------------------------------------------------------------

async function handleAuth(request: Request, cfg: FaucetConfig, env: Env, url: URL): Promise<Response> {
  const auth = cfg.auth;
  const path = url.pathname;
  if (path === "/auth/logout" && request.method === "POST") {
    // Logging out needs no CSRF token, but a cross-site page still may not do it.
    if (auth.origin && !sameOrigin(request, auth)) {
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

  if (match[2] === "login") {
    return startLogin(provider, client, auth, url.searchParams.get("return"));
  }
  const outcome = await finishLogin(provider, client, auth, request, url);
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
    const name = body.label === undefined ? "API key" : parseLabel(body.label);
    if (!name) return errorJson(400, LABEL_RULE);
    return issued(await store.issueOwnKey({ ...ownKeyRequest(session, cfg), label: name }), auth.maxKeysPerUser);
  }

  const rotate = /^\/api\/me\/keys\/([0-9a-f]{12})\/rotate$/.exec(path);
  if (rotate && request.method === "POST") {
    return issued(
      await store.issueOwnKey({ ...ownKeyRequest(session, cfg), replacing: rotate[1] }),
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

function ownKeyRequest(session: Session, cfg: FaucetConfig) {
  // Only the identity crosses into the Durable Object, not the session's sid.
  const { sid: _sid, exp: _exp, ...who } = session;
  return {
    who,
    maxActive: cfg.auth.maxKeysPerUser,
    ttlMs: cfg.auth.keyTtlMs,
  };
}

function issued(result: IssueOwnKeyResult, max: number): Response {
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
  return { ok: true, actor: adminHandle(session) };
}

async function handleAdmin(request: Request, cfg: FaucetConfig, env: Env, path: string): Promise<Response> {
  // The admin surface does not exist where keys and codes cannot be used.
  if (!cfg.apiKeys.enabled || (!cfg.apiKeys.adminTokenSha256 && !cfg.auth.origin)) {
    return errorJson(404, "Not found");
  }
  const admin = authorizeAdmin(request, cfg);
  if (!admin.ok) return admin.response;

  if (path === "/api/admin/keys" || path.startsWith("/api/admin/keys/")) {
    return handleAdminKeys(request, env, path, admin.actor);
  }
  if (path === "/api/admin/codes" || path.startsWith("/api/admin/codes/")) {
    return handleAdminCodes(request, cfg, env, path, admin.actor);
  }
  return errorJson(404, "Not found");
}

/** Mint (POST), list (GET) and revoke (DELETE …/<id>) any API key. */
async function handleAdminKeys(request: Request, env: Env, path: string, actor: string): Promise<Response> {
  const store = treasury(env);
  if (path === "/api/admin/keys" && request.method === "GET") {
    return noStore({ keys: await store.listApiKeys() });
  }

  if (path === "/api/admin/keys" && request.method === "POST") {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const name = parseLabel(body.label);
    const { tier, perDay } = body;
    if (!name) return errorJson(400, LABEL_RULE);
    if (typeof tier !== "string" || !KEY_TIERS.includes(tier as KeyTier)) {
      return errorJson(400, `tier must be one of: ${KEY_TIERS.join(", ")}`);
    }
    if (perDay !== undefined && perDay !== null && !isIntInRange(perDay, 1)) {
      return errorJson(400, "perDay must be a positive integer or null (unlimited)");
    }
    const created = await store.createApiKey({
      label: name,
      tier: tier as KeyTier,
      perDay: perDay as number | null | undefined,
      createdBy: actor,
    });
    return noStore(created, 201);
  }

  const revoke = /^\/api\/admin\/keys\/([0-9a-f]{12})$/.exec(path);
  if (revoke && request.method === "DELETE") {
    return (await store.revokeApiKey(revoke[1], undefined, actor))
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
  return isIntInRange(value, 1, MAX_REDEMPTIONS) ? value : undefined;
}

function codeAmount(value: unknown, cfg: FaucetConfig): number | undefined {
  const sats = parseAmountSats(value);
  return sats !== undefined && sats <= cfg.apiKeys.maxPerRequestSats ? sats : undefined;
}

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
    const name = parseLabel(body.label);
    if (!name) return errorJson(400, LABEL_RULE);
    const amountSats = codeAmount(body.amount, cfg);
    if (amountSats === undefined) return errorJson(400, amountRule(cfg));
    const expiresAt = body.expiresAt === undefined ? null : parseExpiry(body.expiresAt, now);
    if (expiresAt === undefined) return errorJson(400, EXPIRY_RULE);

    let codes: string[];
    let maxRedemptions: number;
    if (kind === "event") {
      const display = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (!isEventCode(display)) {
        return errorJson(400, "code must be 4–32 letters, digits or dashes, starting and ending with a letter or digit");
      }
      const max = parseMaxRedemptions(body.maxRedemptions);
      if (max === undefined) return errorJson(400, MAX_REDEMPTIONS_RULE);
      codes = [display];
      maxRedemptions = max;
    } else {
      const count = body.count === undefined ? 1 : body.count;
      if (!isIntInRange(count, 1, MAX_VOUCHERS_PER_BATCH)) {
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
      patch.label = parseLabel(body.label);
      if (patch.label === undefined) return errorJson(400, LABEL_RULE);
    }
    if (body.amount !== undefined) {
      patch.amountSats = codeAmount(body.amount, cfg);
      if (patch.amountSats === undefined) return errorJson(400, amountRule(cfg));
    }
    if (body.maxRedemptions !== undefined) {
      patch.maxRedemptions = parseMaxRedemptions(body.maxRedemptions);
      if (patch.maxRedemptions === undefined) {
        return errorJson(400, MAX_REDEMPTIONS_RULE);
      }
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = parseExpiry(body.expiresAt, now);
      if (expiresAt === undefined) return errorJson(400, EXPIRY_RULE);
      patch.expiresAt = expiresAt;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return errorJson(400, "disabled must be true or false");
      patch.disabled = body.disabled;
    }
    const updated = await store.updateCode(one[1], patch, actor);
    return updated ? noStore({ code: updated }) : errorJson(404, "No such code");
  }
  return errorJson(404, "Not found");
}
