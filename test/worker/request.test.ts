import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECIPIENT } from "../fixtures";

beforeEach(() => {
  env.TURNSTILE_SECRET = "test-turnstile-secret";
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("Malformed requests must not contact external services");
  }));
});

describe("request body validation", () => {
  for (const path of ["/api/core-faucet", "/api/invitation-faucet", "/cap/v1/redeem"]) {
    it.each([null, [], true, 123, "text"])(`${path} rejects non-object JSON %j`, async (body) => {
      const response = await SELF.fetch(`https://faucet.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it.each(["address", "turnstileToken", "capToken", "hardCapToken"])(
    "rejects a non-string %s before external work",
    async (field) => {
      const response = await SELF.fetch("https://faucet.test/api/core-faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: RECIPIENT.testnet.address, [field]: { length: 114, toString: null } }),
      });
      expect(response.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
