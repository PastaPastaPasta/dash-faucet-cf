import { SELF, env, runInDurableObject } from "cloudflare:test";
import DashKeys from "dashkeys";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { b64url } from "../../src/auth";
import { TREASURY_ID } from "../../src/treasury";
import { FakeChain } from "./fakechain";
import { RECIPIENT } from "../fixtures";

const ORIGIN = "https://faucet.test";
const GOOGLE_CLIENT = "test-google-client.apps.googleusercontent.com";
const chain = new FakeChain();

let rsa: CryptoKeyPair;
let jwk: JsonWebKey;

/** What the fake Google will put in the next ID token, minus the nonce. */
let googleClaims: Record<string, unknown> = {};
/** What the fake GitHub will report for the next login. */
let github = { id: 7, login: "dev", emails: [] as Array<{ email: string; verified: boolean; primary: boolean }>, member: false };
let githubRevoked = 0;

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  const enc = (v: object) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const body = `${enc({ alg: "RS256", kid: "portal-test" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** Nonce from the last Google authorize redirect, which the token must echo. */
let lastNonce = "";

function installProviders(): void {
  chain.install();
  const chainFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        return Response.json({ keys: [{ ...jwk, kid: "portal-test", alg: "RS256", use: "sig" }] });
      }
      if (url === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(String(init.body));
        if (form.get("code") !== "good-code" || !form.get("code_verifier")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          id_token: await signIdToken({
            iss: "https://accounts.google.com",
            aud: GOOGLE_CLIENT,
            iat: now,
            exp: now + 3600,
            nonce: lastNonce,
            ...googleClaims,
          }),
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        const form = new URLSearchParams(String(init.body));
        return form.get("code") === "good-code"
          ? Response.json({ access_token: "gho_test", scope: "read:user,user:email,read:org" })
          : Response.json({ error: "bad_verification_code" });
      }
      if (url === "https://api.github.com/user") return Response.json({ id: github.id, login: github.login, name: null });
      if (url === "https://api.github.com/user/emails") return Response.json(github.emails);
      if (url === "https://api.github.com/user/memberships/orgs/dashpay") {
        return github.member
          ? Response.json({ state: "active", organization: { login: "dashpay" } })
          : Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (url.startsWith("https://api.github.com/applications/") && init.method === "DELETE") {
        githubRevoked += 1;
        return new Response(null, { status: 204 });
      }
      return chainFetch(input, init);
    }),
  );
}

async function resetStore(): Promise<void> {
  const stub = env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
  await runInDurableObject(stub, (_instance, state) => {
    for (const table of [
      "claims", "ip_hits", "spent", "pending", "budget", "used_cap",
      "api_keys", "key_payouts", "users", "codes", "code_redemptions",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}

beforeAll(async () => {
  rsa = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", rsa.publicKey)) as JsonWebKey;
});

beforeEach(async () => {
  await resetStore();
  chain.height = 100;
  chain.coins = [{ txid: "d".repeat(64), vout: 0, satoshis: 2000 * 100_000_000 }];
  chain.broadcast = { kind: "accept" };
  chain.known.clear();
  chain.broadcastAttempts.length = 0;
  chain.siteverifySucceeds = true;
  env.TURNSTILE_SECRET = "test-turnstile-secret";
  googleClaims = {};
  github = { id: 7, login: "dev", emails: [], member: false };
  githubRevoked = 0;
  installProviders();
});

function cookiesFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

/** Run a full login and return the session cookie, or the error the callback redirected with. */
async function login(provider: "google" | "github"): Promise<{ cookie?: string; location: string }> {
  const start = await SELF.fetch(`${ORIGIN}/auth/${provider}/login?return=/admin`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get("Location")!);
  lastNonce = authorize.searchParams.get("nonce") ?? "";
  const stateCookie = cookiesFrom(start);
  const callback = await SELF.fetch(
    `${ORIGIN}/auth/${provider}/callback?code=good-code&state=${authorize.searchParams.get("state")}`,
    { redirect: "manual", headers: { Cookie: stateCookie } },
  );
  expect(callback.status).toBe(302);
  const cookie = cookiesFrom(callback);
  return { cookie: cookie || undefined, location: callback.headers.get("Location")! };
}

async function me(cookie?: string) {
  const res = await SELF.fetch(`${ORIGIN}/api/me`, { headers: cookie ? { Cookie: cookie } : {} });
  return (await res.json()) as Record<string, any>;
}

/** A same-origin, CSRF-carrying request as the pages make it. */
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const { csrf } = await me(cookie);
  const res = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, "X-CSRF-Token": csrf, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const dashOrg = (email = "dev@dash.org", sub = "g-1") => ({ sub, email, email_verified: true, hd: "dash.org", name: "Dev" });

describe("Google sign-in", () => {
  it("signs in a verified dash.org account and returns where it started", async () => {
    googleClaims = dashOrg();
    const { cookie, location } = await login("google");
    expect(location).toBe("/admin");
    const who = await me(cookie);
    expect(who.authenticated).toBe(true);
    expect(who.user).toMatchObject({ id: "google:g-1", email: "dev@dash.org", provider: "google" });
    expect(who.admin).toBe(false);
    expect(who.csrf).toEqual(expect.any(String));
  });

  it.each([
    ["another domain", { ...dashOrg("dev@gmail.com"), hd: undefined }],
    ["an unverified address", { ...dashOrg(), email_verified: false }],
    // A consumer Google account registered with a dash.org address: verified,
    // but not a Workspace account, so Google sends no hd.
    ["a dash.org address outside the Workspace", { ...dashOrg(), hd: undefined }],
    ["a Workspace other than dash.org", { ...dashOrg("dev@evil.org"), hd: "evil.org" }],
    ["a dash.org hd with an outside address", { ...dashOrg("dev@evil.org"), hd: "dash.org" }],
  ])("refuses %s", async (_name, claims) => {
    googleClaims = claims;
    const { cookie, location } = await login("google");
    expect(location).toBe("/admin?error=domain");
    expect(cookie).toBeUndefined();
  });

  it("refuses a callback without the matching state cookie", async () => {
    googleClaims = dashOrg();
    const start = await SELF.fetch(`${ORIGIN}/auth/google/login`, { redirect: "manual" });
    const state = new URL(start.headers.get("Location")!).searchParams.get("state");
    const noCookie = await SELF.fetch(`${ORIGIN}/auth/google/callback?code=good-code&state=${state}`, { redirect: "manual" });
    expect(noCookie.headers.get("Location")).toBe("/keys?error=state");
    const wrongState = await SELF.fetch(`${ORIGIN}/auth/google/callback?code=good-code&state=forged`, {
      redirect: "manual",
      headers: { Cookie: cookiesFrom(start) },
    });
    expect(wrongState.headers.get("Location")).toBe("/keys?error=state");
  });

  it("never redirects off-site after login", async () => {
    googleClaims = dashOrg();
    const start = await SELF.fetch(`${ORIGIN}/auth/google/login?return=https://evil.example/`, { redirect: "manual" });
    const authorize = new URL(start.headers.get("Location")!);
    lastNonce = authorize.searchParams.get("nonce")!;
    const done = await SELF.fetch(
      `${ORIGIN}/auth/google/callback?code=good-code&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { Cookie: cookiesFrom(start) } },
    );
    expect(done.headers.get("Location")).toBe("/keys");
  });

  it("sends portal pages and logins on other hosts to the login origin", async () => {
    const res = await SELF.fetch("https://other.example/keys?x=1", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/keys?x=1`);
  });
});

describe("GitHub sign-in", () => {
  it("accepts a dashpay org member and revokes the GitHub token", async () => {
    github = { ...github, member: true };
    const { cookie } = await login("github");
    expect((await me(cookie)).user).toMatchObject({ id: "github:7", login: "dev" });
    expect(githubRevoked).toBe(1);
  });

  it("accepts a verified dash.org address without org membership", async () => {
    github = { ...github, emails: [{ email: "Dev@Dash.org", verified: true, primary: false }] };
    const { cookie } = await login("github");
    expect((await me(cookie)).user.email).toBe("dev@dash.org");
  });

  it("refuses everyone else, including an unverified dash.org address", async () => {
    github = { ...github, emails: [{ email: "dev@dash.org", verified: false, primary: true }] };
    const { cookie, location } = await login("github");
    expect(cookie).toBeUndefined();
    expect(location).toBe("/admin?error=domain");
    expect(githubRevoked).toBe(1);
  });
});

describe("self-serve keys", () => {
  it("issue, list, rotate and revoke, with the value shown once", async () => {
    googleClaims = dashOrg();
    const { cookie } = await login("google");

    const created = await call(cookie!, "POST", "/api/me/keys", { label: "laptop" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^dfk_/);
    expect(created.body.key).toMatchObject({ tier: "trusted", owner: "google:g-1", label: "laptop" });
    expect(created.body.key.expiresAt).toBeGreaterThan(Date.now() + 179 * 86_400_000);

    const listed = await call(cookie!, "GET", "/api/me/keys");
    expect(listed.body.keys).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    // The key pays without a captcha.
    const pay = await SELF.fetch(`${ORIGIN}/api/core-faucet`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ address: RECIPIENT.testnet.address, amount: 3 }),
    });
    expect(pay.status).toBe(200);

    const rotated = await call(cookie!, "POST", `/api/me/keys/${created.body.key.id}/rotate`);
    expect(rotated.status).toBe(201);
    expect(rotated.body.key.label).toBe("laptop");
    const after = (await call(cookie!, "GET", "/api/me/keys")).body.keys;
    expect(after.find((k: any) => k.id === created.body.key.id).revokedAt).not.toBeNull();

    const revoked = await call(cookie!, "DELETE", `/api/me/keys/${rotated.body.key.id}`);
    expect(revoked.status).toBe(200);
  });

  it("stop paying once expired, and an expired key cannot be rotated", async () => {
    googleClaims = dashOrg();
    const { cookie } = await login("google");
    const created = (await call(cookie!, "POST", "/api/me/keys", {})).body;
    const stub = env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`UPDATE api_keys SET expires_at = ? WHERE id = ?`, Date.now() - 1, created.key.id);
    });
    const pay = await SELF.fetch(`${ORIGIN}/api/core-faucet`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.token}`, "content-type": "application/json" },
      body: JSON.stringify({ address: RECIPIENT.testnet.address }),
    });
    expect(pay.status).toBe(401);
    // Rotating would otherwise mint a live key without counting against the cap.
    expect((await call(cookie!, "POST", `/api/me/keys/${created.key.id}/rotate`)).status).toBe(404);
  });

  it("caps active keys per person", async () => {
    googleClaims = dashOrg();
    const { cookie } = await login("google");
    // MAX_KEYS_PER_USER is 2 in the test config.
    expect((await call(cookie!, "POST", "/api/me/keys", {})).status).toBe(201);
    expect((await call(cookie!, "POST", "/api/me/keys", {})).status).toBe(201);
    expect((await call(cookie!, "POST", "/api/me/keys", {})).status).toBe(409);
  });

  it("cannot touch someone else's key", async () => {
    googleClaims = dashOrg("a@dash.org", "g-a");
    const alice = (await login("google")).cookie!;
    googleClaims = dashOrg("b@dash.org", "g-b");
    const bob = (await login("google")).cookie!;
    const key = (await call(alice, "POST", "/api/me/keys", {})).body.key;
    expect((await call(bob, "DELETE", `/api/me/keys/${key.id}`)).status).toBe(404);
    expect((await call(bob, "POST", `/api/me/keys/${key.id}/rotate`)).status).toBe(404);
    expect((await call(bob, "GET", "/api/me/keys")).body.keys).toHaveLength(0);
  });

  it("refuses writes without the CSRF token or from another origin", async () => {
    googleClaims = dashOrg();
    const { cookie } = await login("google");
    const { csrf } = await me(cookie);
    const post = (headers: Record<string, string>) =>
      SELF.fetch(`${ORIGIN}/api/me/keys`, {
        method: "POST",
        headers: { Cookie: cookie!, "content-type": "application/json", ...headers },
        body: "{}",
      });
    expect((await post({ Origin: ORIGIN })).status).toBe(403);
    expect((await post({ Origin: "https://evil.example", "X-CSRF-Token": csrf })).status).toBe(403);
    expect((await post({ "X-CSRF-Token": csrf })).status).toBe(403);
    expect((await post({ Origin: ORIGIN, "X-CSRF-Token": csrf })).status).toBe(201);
  });

  it("requires a session", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/me/keys`);
    expect(res.status).toBe(401);
    const forged = await SELF.fetch(`${ORIGIN}/api/me/keys`, {
      headers: { Cookie: "__Host-faucet_session=e30.AAAA" },
    });
    expect(forged.status).toBe(401);
  });

  it("logs out", async () => {
    googleClaims = dashOrg();
    const { cookie } = await login("google");
    const out = await SELF.fetch(`${ORIGIN}/auth/logout`, { method: "POST", headers: { Cookie: cookie!, Origin: ORIGIN } });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toMatch(/^__Host-faucet_session=;.*Max-Age=0/);
  });
});

describe("admin", () => {
  async function adminCookie() {
    googleClaims = dashOrg("admin@dash.org", "g-admin");
    return (await login("google")).cookie!;
  }

  it("is only for allowlisted identities", async () => {
    googleClaims = dashOrg();
    const dev = (await login("google")).cookie!;
    expect((await call(dev, "GET", "/api/admin/codes")).status).toBe(401);
    expect((await call(dev, "GET", "/api/admin/keys")).status).toBe(401);

    const admin = await adminCookie();
    expect((await me(admin)).admin).toBe(true);
    expect((await call(admin, "GET", "/api/admin/codes")).status).toBe(200);

    // The GitHub admin is pinned by numeric id, not login.
    github = { id: 4242, login: "renamed", emails: [], member: true };
    const gh = (await login("github")).cookie!;
    expect((await me(gh)).admin).toBe(true);
  });

  it("lists and revokes anyone's keys, and mints mn keys", async () => {
    googleClaims = dashOrg();
    const dev = (await login("google")).cookie!;
    const own = (await call(dev, "POST", "/api/me/keys", { label: "ci" })).body.key;

    const admin = await adminCookie();
    const all = (await call(admin, "GET", "/api/admin/keys")).body.keys;
    expect(all.find((k: any) => k.id === own.id)).toMatchObject({ ownerEmail: "dev@dash.org" });
    expect((await call(admin, "DELETE", `/api/admin/keys/${own.id}`)).status).toBe(200);

    const mn = await call(admin, "POST", "/api/admin/keys", { label: "operator", tier: "mn" });
    expect(mn.status).toBe(201);
    expect(mn.body.key.tier).toBe("mn");
  });

  it("creates, edits and disables codes; codes pay through the captcha path", async () => {
    const admin = await adminCookie();
    const event = await call(admin, "POST", "/api/admin/codes", {
      kind: "event", code: "dashcon-24", label: "DashCon", amount: 25, maxRedemptions: 2,
    });
    expect(event.status).toBe(201);
    const code = event.body.codes[0];
    expect(code).toMatchObject({ code: "DASHCON-24", amountSats: 25 * 100_000_000, maxRedemptions: 2 });

    expect((await call(admin, "POST", "/api/admin/codes", {
      kind: "event", code: "DASHCON24", label: "dup", amount: 1, maxRedemptions: 1,
    })).status).toBe(409);

    const redeem = (code: string, address: string, ip: string) =>
      SELF.fetch(`${ORIGIN}/api/core-faucet`, {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ address, code, turnstileToken: "ok" }),
      });

    const second = await DashKeys.pkhToAddr(new Uint8Array(20).fill(9), { version: "testnet" });
    const third = await DashKeys.pkhToAddr(new Uint8Array(20).fill(10), { version: "testnet" });

    const first = await redeem("dashcon 24", RECIPIENT.testnet.address, "203.0.113.80");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ amount: 25, code: "DashCon" });

    // The same address again is refused, even from another network.
    const again = await redeem("DASHCON-24", RECIPIENT.testnet.address, "203.0.113.81");
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toBe("This code was already redeemed by this address");

    const detail = await call(admin, "GET", `/api/admin/codes/${code.id}`);
    expect(detail.body.redemptions).toHaveLength(1);

    // Disabled: refused, with the same answer as an unknown code.
    const disabled = await call(admin, "PATCH", `/api/admin/codes/${code.id}`, { disabled: true, amount: 30 });
    expect(disabled.body.code).toMatchObject({ disabled: true, amountSats: 30 * 100_000_000 });
    const off = await redeem("DASHCON-24", second, "203.0.113.80");
    expect(off.status).toBe(400);
    expect(((await off.json()) as any).error).toBe("Invalid, expired or fully redeemed code");

    // Re-enabled, a second attendee behind the *same* venue NAT can redeem.
    await call(admin, "PATCH", `/api/admin/codes/${code.id}`, { disabled: false });
    const nat = await redeem("DASHCON-24", second, "203.0.113.80");
    expect(nat.status).toBe(200);
    expect(((await nat.json()) as any).amount).toBe(30);

    // The cap of 2 is reached; raising it lets the next person in.
    expect((await redeem("DASHCON-24", third, "203.0.113.84")).status).toBe(400);
    await call(admin, "PATCH", `/api/admin/codes/${code.id}`, { maxRedemptions: 3 });
    expect((await redeem("DASHCON-24", third, "203.0.113.84")).status).toBe(200);
  });

  it("issues single-use vouchers in a batch", async () => {
    const admin = await adminCookie();
    const batch = await call(admin, "POST", "/api/admin/codes", { kind: "voucher", count: 3, label: "meetup", amount: 10 });
    expect(batch.status).toBe(201);
    expect(batch.body.codes).toHaveLength(3);
    for (const v of batch.body.codes) {
      expect(v.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(v.maxRedemptions).toBe(1);
    }
  });

  it("validates code input", async () => {
    const admin = await adminCookie();
    for (const body of [
      { kind: "event", code: "x", label: "l", amount: 1, maxRedemptions: 1 },
      { kind: "event", code: "GOOD", label: "l", amount: 0, maxRedemptions: 1 },
      { kind: "event", code: "GOOD", label: "l", amount: 99999, maxRedemptions: 1 },
      { kind: "event", code: "GOOD", label: "l", amount: 1, maxRedemptions: 0 },
      { kind: "event", code: "GOOD", label: "l", amount: 1, maxRedemptions: 1, expiresAt: 5 },
      { kind: "voucher", count: 201, label: "l", amount: 1 },
      { kind: "other", label: "l", amount: 1 },
    ]) {
      expect((await call(admin, "POST", "/api/admin/codes", body)).status).toBe(400);
    }
  });

  it("still accepts the operator's bearer token", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/admin/codes`, { headers: { Authorization: "Bearer test-admin-token" } });
    expect(res.status).toBe(200);
    const wrong = await SELF.fetch(`${ORIGIN}/api/admin/codes`, { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });
});

describe("portal pages", () => {
  it.each(["/keys", "/admin"])("%s is served with a strict CSP and no caching", async (path) => {
    const res = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("<title>");
  });
});
