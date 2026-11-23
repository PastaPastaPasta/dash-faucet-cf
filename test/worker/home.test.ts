import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://faucet.test";

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });
}

describe("/ with a mainnet network parameter", () => {
  it.each([
    ["/?network=mainnet", "/invitations"],
    ["/?network=MAINNET", "/invitations"],
    ["/?network=main", "/invitations"],
    ["/?net=main", "/invitations"],
    ["/?net=mainnet", "/invitations"],
    ["/?network=%20Mainnet%20", "/invitations"],
    ["/?network=bogus&net=main", "/invitations"],
    ["/?network=mainnet&net=main", "/invitations"],
    ["/?code=abc&network=mainnet&from=bridge", "/invitations?code=abc&from=bridge"],
  ])("redirects %s to %s", async (path, location) => {
    const response = await get(path);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}${location}`);
    await response.body?.cancel();
  });

  it("redirects HEAD too", async () => {
    const response = await get("/?network=mainnet", { method: "HEAD" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/invitations`);
  });

  it.each(["/", "/?network=testnet", "/?net=test", "/?network=testnet&net=main", "/?network=devnet-alpha&net=main", "/?network=bogus"])(
    "serves the testnet faucet for %s",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('network="testnet"');
      expect(html).toContain("Get testnet DASH");
    },
  );

  it.each(["/invitations?network=mainnet", "/invitations?network=testnet", "/keys?network=mainnet"])(
    "leaves %s alone",
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Location")).toBeNull();
      await response.body?.cancel();
    },
  );
});
