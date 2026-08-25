import { describe, expect, it } from "vitest";
import { clientIp, errorJson, normalizeIp } from "../src/http";

describe("normalizeIp", () => {
  it("passes IPv4 through untouched", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it("truncates IPv6 to its /48 prefix", () => {
    // A subscriber holding a /48 could otherwise walk addresses to reset the
    // limit, so everything below the /48 collapses to one bucket.
    expect(normalizeIp("2001:db8:1234:5678:9abc:def0:1234:5678")).toBe(
      "2001:db8:1234::/48",
    );
    expect(normalizeIp("2001:db8:1234:ffff::1")).toBe("2001:db8:1234::/48");
  });

  it("collapses two addresses in the same /48 to one bucket", () => {
    expect(normalizeIp("2001:db8:1234:1::1")).toBe(
      normalizeIp("2001:db8:1234:2::9999"),
    );
  });

  it("separates addresses in different /48s", () => {
    expect(normalizeIp("2001:db8:1234::1")).not.toBe(
      normalizeIp("2001:db8:1235::1"),
    );
  });

  it("expands :: correctly", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(normalizeIp("::1")).toBe("0:0:0::/48");
  });

  it("strips a zone index", () => {
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0::/48");
  });

  it("returns unrecognised input verbatim", () => {
    expect(normalizeIp("not:an:ip")).toBe("not:an:ip");
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://f/api/core-faucet", { headers });

  it("prefers CF-Connecting-IP", () => {
    expect(
      clientIp(req({ "CF-Connecting-IP": "203.0.113.7", "X-Forwarded-For": "1.2.3.4" })),
    ).toBe("203.0.113.7");
  });

  it("takes the first hop of X-Forwarded-For", () => {
    expect(clientIp(req({ "X-Forwarded-For": "203.0.113.7, 70.41.3.18" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to X-Real-IP, then to a constant", () => {
    expect(clientIp(req({ "X-Real-IP": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("normalises IPv6 from the header", () => {
    expect(clientIp(req({ "CF-Connecting-IP": "2001:db8:1234:5::1" }))).toBe(
      "2001:db8:1234::/48",
    );
  });
});

describe("errorJson", () => {
  it("carries both the flat shape and FastAPI's nested detail", async () => {
    // Clients written against the old Python faucet read `detail.error`.
    const res = errorJson(429, "Rate limit exceeded", { retryAfter: 42 });
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(429);
    expect(body.error).toBe("Rate limit exceeded");
    expect(body.retryAfter).toBe(42);
    expect(body.detail.error).toBe("Rate limit exceeded");
    expect(body.detail.retryAfter).toBe(42);
  });

  it("sets permissive CORS headers", () => {
    expect(
      errorJson(400, "nope").headers.get("Access-Control-Allow-Origin"),
    ).toBe("*");
  });
});
