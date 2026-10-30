import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { codeKey } from "../src/accounts";
import { digestEquals as safeEqual } from "../src/apikeys";
import { b64url, seal, unseal, verifyGoogleIdToken } from "../src/auth";

const SECRET = "unit-test-session-secret-0123456789";

describe("sealed cookies", () => {
  it("round-trips, and rejects tampering, the wrong purpose and expiry", () => {
    const now = 1_000_000;
    const token = seal(SECRET, "session", { id: "google:1", exp: now + 1000 });
    expect(unseal(SECRET, "session", token, now)).toEqual({ id: "google:1", exp: now + 1000 });

    // A state cookie must never be accepted as a session, and vice versa.
    expect(unseal(SECRET, "oauth", token, now)).toBeNull();
    expect(unseal("another-secret-0123456789abcdefghij", "session", token, now)).toBeNull();
    expect(unseal(SECRET, "session", token, now + 1000)).toBeNull();

    const [payload, mac] = token.split(".");
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ id: "github:4242", exp: now + 1000 })));
    expect(unseal(SECRET, "session", `${forged}.${mac}`, now)).toBeNull();
    expect(unseal(SECRET, "session", `${payload}.${mac}x`, now)).toBeNull();
    expect(unseal(SECRET, "session", `${payload}.${mac}.extra`, now)).toBeNull();
    expect(unseal(SECRET, "session", undefined, now)).toBeNull();
    expect(unseal(SECRET, "session", "garbage", now)).toBeNull();
  });

  it("compares in constant time and only equal strings match", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("normalizes codes for matching", () => {
    expect(codeKey(" dashcon-24 ")).toBe("DASHCON24");
    expect(codeKey("ab cd-EF")).toBe("ABCDEF");
  });
});

describe("Google ID token verification", () => {
  const CLIENT = "client.apps.googleusercontent.com";
  const NONCE = "the-nonce";
  const NOW = Date.UTC(2026, 9, 30);
  let key: CryptoKeyPair;
  let jwk: JsonWebKey;

  beforeAll(async () => {
    key = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    jwk = (await crypto.subtle.exportKey("jwk", key.publicKey)) as JsonWebKey;
  });

  afterEach(() => vi.unstubAllGlobals());

  function serveJwks(kid = "k1") {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] })));
  }

  async function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) {
    const enc = (v: object) => b64url(new TextEncoder().encode(JSON.stringify(v)));
    const body = `${enc(header)}.${enc(claims)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(body));
    return `${body}.${b64url(new Uint8Array(sig))}`;
  }

  const good = () => ({
    iss: "https://accounts.google.com",
    aud: CLIENT,
    sub: "1234",
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 3600,
    nonce: NONCE,
    email: "dev@dash.org",
    email_verified: true,
    hd: "dash.org",
  });

  it("accepts a correctly signed token for our client and nonce", async () => {
    serveJwks("k-accept");
    const claims = await verifyGoogleIdToken(await token(good(), { alg: "RS256", kid: "k-accept" }), CLIENT, NONCE, NOW);
    expect(claims?.email).toBe("dev@dash.org");
  });

  it.each([
    ["another audience", { aud: "someone-else" }],
    ["another nonce", { nonce: "replayed" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["an expired token", { exp: Math.floor(NOW / 1000) - 3600 }],
    ["a token from the future", { iat: Math.floor(NOW / 1000) + 3600 }],
  ])("rejects %s", async (_name, change) => {
    serveJwks("k-reject");
    const t = await token({ ...good(), ...change }, { alg: "RS256", kid: "k-reject" });
    expect(await verifyGoogleIdToken(t, CLIENT, NONCE, NOW)).toBeNull();
  });

  it("rejects a bad signature, alg none and an unknown key id", async () => {
    serveJwks("k-sig");
    const t = await token(good(), { alg: "RS256", kid: "k-sig" });
    const [h, p] = t.split(".");
    const other = await token({ ...good(), sub: "999" }, { alg: "RS256", kid: "k-sig" });
    expect(await verifyGoogleIdToken(`${h}.${other.split(".")[1]}.${t.split(".")[2]}`, CLIENT, NONCE, NOW)).toBeNull();
    const none = `${b64url(new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "k-sig" })))}.${p}.`;
    expect(await verifyGoogleIdToken(none, CLIENT, NONCE, NOW)).toBeNull();
    const unknown = await token(good(), { alg: "RS256", kid: "nobody" });
    expect(await verifyGoogleIdToken(unknown, CLIENT, NONCE, NOW)).toBeNull();
  });
});
