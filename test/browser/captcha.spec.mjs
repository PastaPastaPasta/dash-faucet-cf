import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const origin = "https://faucet.test";

// Exercise the shipped page with deterministic CAPTCHA providers and payouts.
// Worker tests separately solve and verify real CAP challenges and rate tiers.
async function openFaucet(page, { turnstile = "missing", network = "testnet", responses = [], statusResponses = [], invitation = false, query = "" } = {}) {
  const requests = [];
  const startsUnavailable = statusResponses.length > 0;
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") {
      if (statusResponses.length) return route.fulfill(statusResponses.shift());
      return route.fulfill({ json: {
        status: "ok", network, balance: 100, blockHeight: 100,
        coreFaucetAmount: 1, rateLimitPerHour: 3,
        turnstileSiteKey: turnstile === "no-key" ? "" : "test-key", capEndpoint: `${origin}/cap/v1/`,
        hardCapEndpoint: `${origin}/cap/hard/`,
        invitationsEnabled: true, invitationNetwork: "mainnet",
        invitationAmount: 0.03, invitationMaxPerRequest: 1,
        invitationInventory: { available: 1 },
      } });
    }
    if (path === "/api/core-faucet") {
      requests.push(route.request().postDataJSON());
      return route.fulfill(responses.shift() || { json: { txid: "a".repeat(64), amount: 1 } });
    }
    return route.fulfill({
      contentType: /\.m?js$/.test(path) ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".woff2") ? "font/woff2" : "text/html",
      body: await readFile(new URL(`../../public${path === "/" ? "/index.html" : path === "/invitations" ? "/invitations.html" : path}`, import.meta.url)),
    });
  });
  await page.route("https://challenges.cloudflare.com/**", (route) => route.abort());
  await page.addInitScript(({ turnstile }) => {
    window.powSolves = [];
    customElements.define("cap-widget", class extends HTMLElement {
      connectedCallback() {
        this.innerHTML = '<button type="button">Solve proof of work</button>';
        this.querySelector("button").onclick = () => this.solve();
      }
      async solve() {
        const endpoint = this.getAttribute("data-cap-api-endpoint");
        window.powSolves.push(endpoint);
        this.dispatchEvent(new CustomEvent("progress", { detail: { progress: 10 } }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        this.dispatchEvent(new CustomEvent("solve", { detail: { token: `pow-${window.powSolves.length}` } }));
      }
    });
    const appendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (node) {
      if (node.tagName === "SCRIPT" && new URL(node.src).pathname === "/vendor/cap.min.js") {
        queueMicrotask(() => node.onload());
        return node;
      }
      return appendChild.call(this, node);
    };
    if (turnstile !== "missing") {
      window.turnstile = {
        render: () => "widget-id",
        reset: () => {},
        remove: () => {},
        execute: (_id, opts) => {
          if (turnstile === "throw") throw new Error("Widget unavailable");
          if (turnstile === "stall") return;
          if (turnstile === "success") opts.callback("web-token");
          else opts[turnstile]();
        },
      };
    }
  }, { turnstile });
  await page.goto(origin + (invitation ? "/invitations" : "/") + query);
  if (startsUnavailable) return requests;
  await expect(page.locator("#statusBar")).toContainText(invitation ? "Mainnet invitations" : "Faucet online");
  if (!invitation) {
    await page.locator("#addressInput").fill(network === "mainnet" ? "Xp3oTrxmd5JL6qA1MKFDjkUeqgGXuRfGjv" : "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs");
    await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  }
  return requests;
}

for (const turnstile of ["missing", "no-key", "throw", "error-callback", "timeout-callback", "expired-callback", "unsupported-callback", "before-interactive-callback", "stall"]) {
  test(`automatically falls back when Turnstile reports ${turnstile}`, async ({ page }) => {
    const requests = await openFaucet(page, { turnstile });
    if (turnstile === "stall") await page.clock.install();
    await page.locator("#coreFaucetBtn").click();
    if (turnstile === "stall") await page.clock.fastForward(8100);
    await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
    expect(requests).toEqual([{ address: "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs", capToken: "pow-1" }]);
    expect(await page.evaluate(() => window.powSolves)).toEqual([`${origin}/cap/v1/`]);
    await expect(page.locator("#coreFaucetBtn")).toBeDisabled();
    await page.locator("#sendMoreBtn").click();
    await page.locator("#addressInput").fill("yfJZVF5WhFsVXCvqiR4JqAM3TmEf3LpPfw");
    await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  });
}

test("uses a successful Turnstile proof without doing PoW", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success" });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests[0].turnstileToken).toBe("web-token");
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test("server rejection retries with a fresh PoW credential", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", responses: [
    { status: 400, json: { error: "Captcha verification unavailable", requiresProofOfWork: true } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([
    { address: "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs", turnstileToken: "web-token" },
    { address: "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs", capToken: "pow-1" },
  ]);
});

test("soft PoW can escalate, but hard PoW requires a click and never loops", async ({ page }) => {
  const requests = await openFaucet(page, { responses: [
    { status: 429, json: { error: "Rate limit exceeded", requiresHardCaptcha: true } },
    { status: 429, json: { error: "Rate limit exceeded", retryAfter: 600 } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#capTitle")).toHaveText("Hourly limit reached");
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => window.powSolves)).toEqual([`${origin}/cap/v1/`]);
  await page.locator("cap-widget button").click();
  await expect(page.locator("#coreErrorBox")).toContainText("Rate limit exceeded");
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => window.powSolves)).toEqual([`${origin}/cap/v1/`, `${origin}/cap/hard/`]);
});

test("unrelated server failures do not trigger PoW", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", responses: [
    { status: 503, json: { error: "Insufficient funds" } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("Insufficient funds");
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test("rejected PoW waits for a click and uses a fresh token on retry", async ({ page }) => {
  const requests = await openFaucet(page, { responses: [
    { status: 400, json: { error: "Captcha token already used" } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("Captcha token already used");
  expect(requests).toHaveLength(1);
  await page.locator("cap-widget button").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests.map((request) => request.capToken)).toEqual(["pow-1", "pow-2"]);
});

test("mainnet core does not use the automatic fallback", async ({ page }) => {
  const requests = await openFaucet(page, { network: "mainnet" });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("Captcha failed to load");
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test("mainnet invitations require Turnstile on their own Mainnet page", async ({ page }) => {
  await openFaucet(page, { invitation: true });
  await page.locator("#invitationBtn").click();
  await expect(page.locator("#invitationErrorBox")).toContainText("Captcha failed to load");
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test('checks malformed, wrong-network and checksum errors before a payout', async ({ page }) => {
  const requests = await openFaucet(page);
  await expect(page.locator('#invitationCard')).toBeHidden();
  await expect(page.locator('.dh-steps li').first()).toHaveAttribute('data-state', 'done');
  for (const [address, message] of [
    ['yNotARealAddress', '34 characters'],
    ['Xp3oTrxmd5JL6qA1MKFDjkUeqgGXuRfGjv', 'Testnet'],
    ['yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKt', 'checksum'],
  ]) {
    await page.locator('#addressInput').fill(address);
    await expect(page.locator('#addressValidation')).toContainText(message);
    await expect(page.locator('#addressInput')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.dh-steps li').first()).toHaveAttribute('data-state', 'todo');
    await expect(page.locator('#coreFaucetBtn')).toBeDisabled();
  }
  expect(requests).toEqual([]);
});


test("unknown availability preserves the address and records retry and last-success context", async ({ page }) => {
  const address = "yXFTcoYd8F7Ty9U6PZCbA8xZgX6xJnWku9";
  const statusResponses = [{ status: 503, json: { error: "upstream unavailable" } }];
  await openFaucet(page, { statusResponses, query: "?from=bridge&journey=start&address=" + address });
  await expect(page.locator("#statusBar")).toContainText("Availability unknown");
  await expect(page.locator("#statusBar")).toContainText("does not confirm the faucet is down");
  await expect(page.locator("#statusBar")).toContainText("No successful check in this tab");
  await expect(page.locator("#addressInput")).toHaveValue(address);
  await page.locator("#retryStatusBtn").click();
  await expect(page.locator("#statusBar")).toContainText("Checked");
  await expect(page.locator("#networkChoice")).toBeHidden();
  statusResponses.push({ status: 502, body: "status service failed" });
  await page.locator("#retryStatusBtn").evaluate(button => button.click());
  await expect(page.locator("#statusBar")).toContainText("Last successful check:");
  await expect(page.locator("#coreFaucetBtn")).toBeDisabled();
  await expect(page.locator("#addressInput")).toHaveValue(address);
});

test("keeps Mainnet invitations out of a Bridge funding handoff", async ({ page }) => {
  await openFaucet(page, { query: "?from=bridge&journey=start&address=public-address" });
  await expect(page.locator("#statusBar")).toContainText("Faucet online");
  await expect(page.locator("#networkChoice")).toBeHidden();
  await expect(page.locator("#bridgeReturnActions")).toBeVisible();
});
