/**
 * Sign-in for self-serve API keys: Google (dash.org Workspace) and GitHub.
 *
 * No server-side session store. A session is an HMAC-signed cookie carrying
 * the identity and a 12-hour expiry; the OAuth round trip is protected by a
 * second signed cookie holding `state`, the OIDC `nonce`, the PKCE verifier
 * and where to return, valid for 10 minutes and spent by the callback.
 *
 * Who may sign in is decided here, on every login, from what the provider
 * vouches for — never from anything the browser sends:
 *
 * - Google: an ID token whose signature checks out against Google's published
 *   keys, issued to our client, with `email_verified`, `hd` equal to the
 *   Workspace domain, and an address in that domain. The `hd` request
 *   parameter only pre-selects an account; it is not a check.
 * - GitHub: an active member of the configured org, or an account with a
 *   verified address in the Workspace domain. The GitHub token is used for
 *   those two reads and then revoked.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Identity } from "./accounts";
import { digestEquals } from "./apikeys";
import type { AuthConfig, OAuthClient } from "./config";

export type Provider = "google" | "github";
const PROVIDERS: readonly Provider[] = ["google", "github"];

export interface Session extends Identity {
  /** Random per login; the CSRF token is derived from it. */
  sid: string;
  exp: number;
}

interface OAuthState {
  provider: Provider;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

const SESSION_COOKIE = "__Host-faucet_session";
const OAUTH_COOKIE = "__Host-faucet_oauth";
const SESSION_TTL_MS = 12 * 3_600_000;
const OAUTH_TTL_MS = 10 * 60_000;
/** Pages a login may return to. Anything else returns to `/keys`. */
const RETURN_PATHS = new Set(["/keys", "/admin"]);
const USER_AGENT = "dash-faucet-cf (+https://github.com/PastaPastaPasta/dash-faucet-cf)";

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- encoding and signing ------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function mac(secret: string, purpose: string, data: string): string {
  return b64url(hmac(sha256, enc.encode(secret), enc.encode(`${purpose}.${data}`)));
}

/** `payload.mac`, where the MAC binds the purpose so a state cookie is never a session. */
export function seal(secret: string, purpose: string, value: object): string {
  const payload = b64url(enc.encode(JSON.stringify(value)));
  return `${payload}.${mac(secret, purpose, payload)}`;
}

export function unseal<T extends { exp: number }>(
  secret: string,
  purpose: string,
  token: string | undefined,
  now = Date.now(),
): T | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!digestEquals(signature, mac(secret, purpose, payload))) return null;
  try {
    const value = JSON.parse(dec.decode(fromB64url(payload))) as T;
    return typeof value.exp === "number" && value.exp > now ? value : null;
  } catch {
    return null;
  }
}

// --- cookies -----------------------------------------------------------------

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * `__Host-` pins the cookie to this exact host, https and path `/`. Lax lets
 * it ride the top-level redirect back from the provider, and keeps it off
 * every cross-site POST.
 */
function cookie(name: string, value: string, maxAgeMs: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1000));
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

export function readSession(request: Request, cfg: AuthConfig): Session | null {
  if (!cfg.sessionSecret) return null;
  return unseal<Session>(cfg.sessionSecret, "session", readCookie(request, SESSION_COOKIE));
}

/**
 * How `AUTH_ADMINS` names a session: Google by Workspace address, GitHub by
 * numeric id (already the session id), so a renamed login inherits nothing.
 */
export function adminHandle(session: Session): string {
  return session.provider === "google" ? `google:${session.email.toLowerCase()}` : session.id;
}

export function isAdminSession(session: Session, cfg: AuthConfig): boolean {
  return cfg.admins.has(adminHandle(session));
}

/** The browser says this request comes from our own pages. */
export function sameOrigin(request: Request, cfg: AuthConfig): boolean {
  return request.headers.get("Origin") === cfg.origin;
}

/** Per-session CSRF token, sent back by the UI in `X-CSRF-Token`. */
export function csrfToken(session: Session, cfg: AuthConfig): string {
  return mac(cfg.sessionSecret, "csrf", session.sid);
}

/**
 * A cookie-authenticated request that changes something must come from our
 * own origin and carry the session's CSRF token. SameSite=Lax already keeps
 * the cookie off cross-site POSTs; this is the second, independent lock.
 */
export function checkCsrf(request: Request, session: Session, cfg: AuthConfig): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  if (!sameOrigin(request, cfg)) return false;
  const token = request.headers.get("X-CSRF-Token") ?? "";
  return digestEquals(token, csrfToken(session, cfg));
}

export function enabledProviders(cfg: AuthConfig): Provider[] {
  return PROVIDERS.filter((p) => cfg[p] !== null);
}

// --- login ---------------------------------------------------------------------

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function callbackUrl(cfg: AuthConfig, provider: Provider): string {
  return `${cfg.origin}/auth/${provider}/callback`;
}

function pkceChallenge(verifier: string): string {
  return b64url(sha256(enc.encode(verifier)));
}

/** `GET /auth/<provider>/login?return=/admin` → the provider's consent page. */
export function startLogin(
  provider: Provider,
  client: OAuthClient,
  cfg: AuthConfig,
  returnParam: string | null,
): Response {
  const flow: OAuthState = {
    provider,
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    returnTo: returnParam && RETURN_PATHS.has(returnParam) ? returnParam : "/keys",
    exp: Date.now() + OAUTH_TTL_MS,
  };
  const challenge = pkceChallenge(flow.verifier);
  const params =
    provider === "google"
      ? new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: callbackUrl(cfg, provider),
          response_type: "code",
          scope: "openid email profile",
          state: flow.state,
          nonce: flow.nonce,
          code_challenge: challenge,
          code_challenge_method: "S256",
          // A hint for the account chooser only; the callback checks `hd`.
          hd: cfg.emailDomain,
          prompt: "select_account",
        })
      : new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: callbackUrl(cfg, provider),
          scope: "read:user user:email read:org",
          state: flow.state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          allow_signup: "false",
        });
  const base =
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize";
  return redirect(`${base}?${params}`, [
    cookie(OAUTH_COOKIE, seal(cfg.sessionSecret, "oauth", flow), OAUTH_TTL_MS),
  ]);
}

export type LoginOutcome =
  | { ok: true; identity: Identity; returnTo: string }
  | { ok: false; error: string; returnTo: string };

/**
 * `GET /auth/<provider>/callback`. Always clears the state cookie: one
 * round trip, one use.
 */
export async function finishLogin(
  provider: Provider,
  client: OAuthClient,
  cfg: AuthConfig,
  request: Request,
  url: URL,
): Promise<LoginOutcome> {
  const flow = unseal<OAuthState>(cfg.sessionSecret, "oauth", readCookie(request, OAUTH_COOKIE));
  const returnTo = flow?.returnTo ?? "/keys";
  const state = url.searchParams.get("state") ?? "";
  if (!flow || flow.provider !== provider || !digestEquals(state, flow.state)) {
    return { ok: false, error: "state", returnTo };
  }
  if (url.searchParams.get("error")) return { ok: false, error: "denied", returnTo };
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, error: "state", returnTo };

  try {
    const identity =
      provider === "google"
        ? await googleIdentity(client, cfg, code, flow)
        : await githubIdentity(client, cfg, code, flow);
    return identity
      ? { ok: true, identity, returnTo }
      : { ok: false, error: "domain", returnTo };
  } catch (err) {
    console.error(`auth: ${provider} login failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "provider", returnTo };
  }
}

/** Response for a finished login: session cookie on success, state cookie cleared either way. */
export function loginResponse(outcome: LoginOutcome, cfg: AuthConfig): Response {
  const clearState = cookie(OAUTH_COOKIE, "", 0);
  if (!outcome.ok) {
    return redirect(`${outcome.returnTo}?error=${encodeURIComponent(outcome.error)}`, [clearState]);
  }
  const session: Session = {
    ...outcome.identity,
    sid: randomToken(16),
    exp: Date.now() + SESSION_TTL_MS,
  };
  return redirect(outcome.returnTo, [
    clearState,
    cookie(SESSION_COOKIE, seal(cfg.sessionSecret, "session", session), SESSION_TTL_MS),
  ]);
}

// --- Google ------------------------------------------------------------------

interface GoogleClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
let jwksCache: { keys: Map<string, CryptoKey>; until: number } | null = null;

async function googleKey(kid: string): Promise<CryptoKey | undefined> {
  if (!jwksCache || jwksCache.until <= Date.now() || !jwksCache.keys.has(kid)) {
    const res = await fetch(GOOGLE_JWKS, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid) continue;
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    }
    jwksCache = { keys, until: Date.now() + 3_600_000 };
  }
  return jwksCache.keys.get(kid);
}

/** Verify a Google ID token's signature and claims; null when any check fails. */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  nonce: string,
  now = Date.now(),
): Promise<GoogleClaims | null> {
  const [headerB64, payloadB64, signatureB64, extra] = idToken.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64 || extra !== undefined) return null;
  const header = JSON.parse(dec.decode(fromB64url(headerB64))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) return null;
  const key = await googleKey(header.kid);
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromB64url(signatureB64),
    enc.encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return null;
  const claims = JSON.parse(dec.decode(fromB64url(payloadB64))) as GoogleClaims;
  const skew = 60;
  const seconds = Math.floor(now / 1000);
  if (
    !GOOGLE_ISSUERS.has(claims.iss) ||
    claims.aud !== clientId ||
    typeof claims.exp !== "number" ||
    claims.exp + skew < seconds ||
    typeof claims.iat !== "number" ||
    claims.iat - skew > seconds ||
    typeof claims.nonce !== "string" ||
    !digestEquals(claims.nonce, nonce)
  ) {
    return null;
  }
  return claims;
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.error === "string") {
    throw new Error(`token exchange: HTTP ${res.status} ${String(body.error ?? "")}`);
  }
  return body;
}

async function googleIdentity(
  client: OAuthClient,
  cfg: AuthConfig,
  code: string,
  flow: OAuthState,
): Promise<Identity | null> {
  const tokens = await postForm("https://oauth2.googleapis.com/token", {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: callbackUrl(cfg, "google"),
    grant_type: "authorization_code",
    code_verifier: flow.verifier,
  });
  if (typeof tokens.id_token !== "string") throw new Error("token response had no id_token");
  const claims = await verifyGoogleIdToken(tokens.id_token, client.clientId, flow.nonce);
  if (!claims) throw new Error("ID token failed verification");
  const email = (claims.email ?? "").toLowerCase();
  if (
    claims.email_verified !== true ||
    (claims.hd ?? "").toLowerCase() !== cfg.emailDomain ||
    !email.endsWith(`@${cfg.emailDomain}`)
  ) {
    return null;
  }
  return { id: `google:${claims.sub}`, provider: "google", email, name: claims.name || email };
}

// --- GitHub ------------------------------------------------------------------

async function githubGet(token: string, path: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });
}

async function githubIdentity(
  client: OAuthClient,
  cfg: AuthConfig,
  code: string,
  flow: OAuthState,
): Promise<Identity | null> {
  const tokens = await postForm("https://github.com/login/oauth/access_token", {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: callbackUrl(cfg, "github"),
    code_verifier: flow.verifier,
  });
  const token = tokens.access_token;
  if (typeof token !== "string" || !token) throw new Error("token response had no access_token");

  try {
    const userRes = await githubGet(token, "/user");
    if (!userRes.ok) throw new Error(`/user HTTP ${userRes.status}`);
    const user = (await userRes.json()) as { id?: number; login?: string; name?: string | null };
    if (typeof user.id !== "number" || typeof user.login !== "string") throw new Error("/user had no id");

    // Either check is enough; neither failing is a refusal, not an error.
    const [emailsRes, memberRes] = await Promise.all([
      githubGet(token, "/user/emails"),
      githubGet(token, `/user/memberships/orgs/${encodeURIComponent(cfg.githubOrg)}`),
    ]);
    const emails = emailsRes.ok
      ? ((await emailsRes.json()) as Array<{ email?: string; verified?: boolean; primary?: boolean }>)
      : [];
    const domainEmail = emails.find(
      (e) => e.verified === true && (e.email ?? "").toLowerCase().endsWith(`@${cfg.emailDomain}`),
    );
    const membership = memberRes.ok
      ? ((await memberRes.json()) as { state?: string; organization?: { login?: string } })
      : null;
    const member =
      membership?.state === "active" &&
      (membership.organization?.login ?? "").toLowerCase() === cfg.githubOrg.toLowerCase();
    if (!domainEmail && !member) return null;

    const primary = emails.find((e) => e.primary && e.verified)?.email;
    const email = (domainEmail?.email ?? primary ?? `${user.login}@users.noreply.github.com`).toLowerCase();
    return {
      id: `github:${user.id}`,
      provider: "github",
      email,
      name: user.name || user.login,
      login: user.login,
    };
  } finally {
    // The token was only ever needed for the reads above.
    await fetch(`https://api.github.com/applications/${encodeURIComponent(client.clientId)}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ access_token: token }),
    }).catch(() => undefined);
  }
}
