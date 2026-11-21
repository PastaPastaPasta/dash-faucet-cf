import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

const origin = "https://faucet.test";
const ADDRESS = "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs";

async function fillCode(page, code) {
  const disclosure = page.locator("details.code-row");
  if (!(await disclosure.evaluate((el) => el.open))) await disclosure.locator("summary").click();
  await page.locator("#codeInput").fill(code);
}

// Exercise the shipped page with deterministic CAPTCHA providers and payouts.
// Worker tests separately solve and verify real CAP challenges and rate tiers.
async function openFaucet(page, { turnstile = "missing", network = "testnet", responses = [], statusResponses = [], invitation = false, query = "", reserve = {}, statusCode = 200, amountLimits, me, headers = [] } = {}) {
  const requests = [];
  const startsUnavailable = statusResponses.length > 0;
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status") {
      if (statusResponses.length) return route.fulfill(statusResponses.shift());
      return route.fulfill({ status: statusCode, json: {
        status: "ok", network, balance: 100, blockHeight: 100,
        coreFaucetAmount: 1, rateLimitPerHour: 3,
        turnstileSiteKey: turnstile === "no-key" ? "" : "test-key", capEndpoint: `${origin}/cap/v1/`,
        hardCapEndpoint: `${origin}/cap/hard/`,
        invitationsEnabled: true, invitationNetwork: "mainnet",
        invitationAmount: 0.03, invitationBalance: 0.0078, invitationMaxPerRequest: 1,
        invitationInventory: { available: 1 },
        ...(amountLimits ? { amountLimits, accountUrl: `${origin}/keys` } : {}),
        ...reserve,
      } });
    }
    if (path === "/api/me") {
      return route.fulfill({ json: me || { authenticated: false, providers: ["google"], loginOrigin: "https://login.test" } });
    }
    if (path === "/api/core-faucet") {
      requests.push(route.request().postDataJSON());
      headers.push(route.request().headers());
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
  await expect(page.locator("#statusBar")).toContainText(invitation ? "Mainnet invitations" : reserve.status === "low_balance" ? "faucet low balance" : "Faucet online");
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
    await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
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
  await expect(page.locator('.dh-steps [aria-current], .dh-steps [data-state]')).toHaveCount(0);
  for (const [address, message] of [
    ['yNotARealAddress', '34 characters'],
    ['Xp3oTrxmd5JL6qA1MKFDjkUeqgGXuRfGjv', 'Testnet'],
    ['yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKt', 'checksum'],
  ]) {
    await page.locator('#addressInput').fill(address);
    await page.locator('#addressInput').blur();
    await expect(page.locator('#addressValidation')).toContainText(message);
    await expect(page.locator('#addressInput')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
    await page.locator('#coreFaucetBtn').click();
    await expect(page.locator('#addressValidation')).toContainText(message);
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
  await expect(page.locator("#statusBar")).toContainText("Faucet online");
  await expect(page.locator("#statusSource")).toContainText("Just now");
  await expect(page.locator("#networkChoice")).toBeHidden();
  statusResponses.push({ status: 502, body: "status service failed" });
  await page.locator("#retryStatusBtn").evaluate(button => button.click());
  await expect(page.locator("#statusBar")).toContainText("Last successful check:");
  await expect(page.locator("#reserveStatus")).toHaveText("Last known balances · status unavailable");
  await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  await expect(page.locator("#addressInput")).toHaveValue(address);
});

test("keeps Mainnet invitations out of a Bridge funding handoff", async ({ page }) => {
  await openFaucet(page, { query: "?from=bridge&journey=start&address=public-address" });
  await expect(page.locator("#statusBar")).toContainText("Faucet online");
  await expect(page.locator("#networkChoice")).toBeHidden();
  await expect(page.locator("#bridgeReturn")).toBeHidden();
});


test("direct funding does not claim progress through identity creation", async ({ page }) => {
  await openFaucet(page);
  await expect(page.locator('.family-platform-band')).toBeHidden();
  await expect(page.locator('.dh-steps [aria-current], .dh-steps [data-state]')).toHaveCount(0);
});

test("Bridge funding returns in one click to the matching resume address", async ({ page, context }) => {
  const address = "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs";
  await openFaucet(page, { query: `?from=bridge&journey=start&address=${address}` });
  await expect(page.locator('.family-platform-band .dh-steps')).toBeVisible();
  await expect(page.locator('.dh-steps [aria-current], .dh-steps [data-state]')).toHaveCount(0);
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#bridgeReturn')).toBeVisible();
  const link = page.locator('#returnBridgeBtn');
  const destination = new URL(await link.getAttribute('href'));
  expect(destination.searchParams.get('mode')).toBe('resume');
  expect(destination.searchParams.get('deposit')).toBe(address);
  expect(destination.searchParams.get('network')).toBe('testnet');
  await expect(link).not.toHaveAttribute('target');
  await page.route(destination.href, route => route.fulfill({ body: '<h1>Bridge resume</h1>', contentType: 'text/html' }));
  const tabs = context.pages().length;
  await link.click();
  await expect(page).toHaveURL(destination.href);
  expect(context.pages().length).toBe(tabs);
});


test("keeps validation quiet until blur and rejects off-origin returns", async ({page}) => {
  await openFaucet(page, {query: '?return=https%3A%2F%2Fevil.test%2F&address=yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs'});
  await expect(page.locator('#addressValidation')).toBeEmpty();
  await page.locator('#addressInput').fill('y-invalid');
  await expect(page.locator('#addressValidation')).toBeEmpty();
  await page.locator('#addressInput').blur();
  await expect(page.locator('#addressValidation')).toContainText('Testnet Core address');
  await expect(page.locator('#bridgeReturn')).toBeHidden();
});


test("shows an amber request action, invitation stock and both reserves before input", async ({ page }) => {
  const requests = await openFaucet(page);
  await page.locator('#addressInput').clear();
  await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
  await expect(page.locator('#coreFaucetBtn')).toHaveClass(/dh-btn--primary/);
  await expect(page.locator('#invitationEntry')).toBeVisible();
  await expect(page.locator('#invitationEntryAvailability')).toHaveText('1 invitation ready now');
  await expect(page.locator('#invitationEntry .description')).toHaveText('Get an invitation with 0.03 DASH for one identity and a non-contested name. Open it in Dash Wallet, then choose your name.');
  await expect(page.locator('#networkChoice')).toHaveClass('dh-btn');
  const request = await page.locator('.faucet-request').boundingBox();
  const invitation = await page.locator('#invitationEntry').boundingBox();
  expect(invitation.y).toBe(request.y);
  expect(invitation.width).toBe(request.width);
  await expect(page.locator('#networkChoice')).toHaveAttribute('href', '/invitations');
  await expect(page.locator('#reserveSummary')).toBeVisible();
  await expect(page.locator('#coreReserveLabel')).toHaveText('Testnet faucet');
  await expect(page.locator('#coreReserveBalance')).toHaveText('≈ 100');
  await expect(page.locator('#coreReserveCurrency')).toHaveText('tDASH');
  await expect(page.locator('#invitationReserveLabel')).toHaveText('Mainnet invitations');
  await expect(page.locator('#invitationReserveBalance')).toHaveText('0.0078');
  await expect(page.locator('#invitationReserveCurrency')).toHaveText('DASH');
  await expect(page.locator('#treasuryPanel')).not.toHaveAttribute('open');
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#addressValidation')).toHaveText('Enter a receiving address.');
  await expect(page.locator('#addressInput')).toBeFocused();
  await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
  expect(requests).toEqual([]);
});

test("submitting with unknown availability gives a recovery message without requesting funds", async ({ page }) => {
  const requests = await openFaucet(page, { statusResponses: [{ status: 503, json: {} }] });
  await expect(page.locator('#statusBar')).toContainText('Availability unknown');
  await page.locator('#addressInput').fill('yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs');
  await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#coreErrorBox')).toContainText('Retry faucet status');
  expect(requests).toEqual([]);
});

for (const [balance, expectedState] of [[1000, "good"], [999.99999999, "warn"], [0, "warn"]]) {
  test(`reserve coverage uses the daily budget at balance ${balance}`, async ({ page }) => {
    await openFaucet(page, { reserve: { balance, dailyBudgetSats: 100_000_000_000 } });
    await expect(page.locator("#coreReserve")).toHaveAttribute("data-state", expectedState);
    await expect(page.locator("#coreReserveCoverage")).toContainText("1,000 tDASH/day");
    await expect(page.locator("#invitationReserve")).toHaveAttribute("data-state", "unknown");
    await expect(page.locator("#invitationReserveCoverage")).toHaveText("Daily payout budget unavailable");
  });
}

test("low-balance status still displays reserve coverage on HTTP 503", async ({ page }) => {
  await openFaucet(page, { statusCode: 503, reserve: { status: "low_balance", balance: 0.5, dailyBudgetSats: 100_000_000 } });
  await expect(page.locator("#reserveSummary")).toBeVisible();
  await expect(page.locator("#coreReserve")).toHaveAttribute("data-state", "warn");
  await expect(page.locator("#coreReserveCoverage")).toContainText("Under a day of payouts");
});


test("home restores the separate mainnet invitation funding address and Copy", async ({ page }) => {
  const address = "Xm77DBJzsf6aMBSb25BAzTNxcjgvUECEeB";
  await page.addInitScript(() => {
    window.copiedFunding = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => window.copiedFunding.push(text) } });
  });
  const reserve = { invitationDepositAddress: address };
  const requests = await openFaucet(page, { reserve });
  await page.locator("#treasuryPanel summary").click();
  await expect(page.locator("#invitationHomeTreasuryCard")).toBeVisible();
  await expect(page.locator("#invitationNetworkBadge")).toHaveText("Mainnet · real DASH");
  await expect(page.locator("#invitationHomeTreasuryCard .network-warning")).toHaveText("Send real mainnet DASH only to this address.");
  await expect(page.locator("#invitationDepositAddress")).toHaveAttribute("value", address);
  expect(await page.locator("#invitationDepositAddress").evaluate(element => element.textContent)).toBe(address);
  await page.locator("#invitationFundingCopy").click();
  await expect(page.locator("#invitationFundingCopy")).toHaveText("Copied");
  expect(await page.evaluate(() => window.copiedFunding)).toEqual([address]);
  expect(requests).toEqual([]);
  delete reserve.invitationDepositAddress;
  await page.locator("#retryStatusBtn").evaluate(button => button.click());
  await expect(page.locator("#invitationHomeTreasuryCard")).toBeHidden();
  await expect(page.locator("#invitationFundingCopy")).toBeDisabled();
});

test("home hides invitation funding when status does not provide an address", async ({ page }) => {
  const requests = await openFaucet(page);
  await page.locator("#treasuryPanel summary").click();
  await expect(page.locator("#invitationHomeTreasuryCard")).toBeHidden();
  expect(requests).toEqual([]);
});

const LIMITS = { turnstileAbove: 10, publicMax: 100, signedInMax: 5000, perIpDaily: 100 };

test("small amounts keep the proof-of-work fallback", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "error-callback", amountLimits: LIMITS });
  await page.locator("#amountInput").fill("5");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, capToken: "pow-1", amount: 5 }]);
});

test("amounts above the Turnstile threshold never fall back to proof of work", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "error-callback", amountLimits: LIMITS });
  await page.locator("#amountInput").fill("50");
  await expect(page.locator("#amountHint")).toContainText("full captcha check");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("need this check");
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test("amounts above the Turnstile threshold pay with Turnstile", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS });
  await page.locator("#amountInput").fill("50");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token", amount: 50 }]);
});

test("amounts above the public maximum ask for a sign-in or a code", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS });
  await page.locator("#amountInput").fill("500");
  await expect(page.locator("#signInBox")).toBeVisible();
  await expect(page.locator("#signInLink")).toHaveAttribute("href", "https://login.test/auth/google/login?return=/");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("dash.org sign-in or a code");
  expect(requests).toEqual([]);

  await page.locator("#signInCodeBtn").click();
  await expect(page.locator("#codeInput")).toBeFocused();
  await page.locator("#codeInput").fill("masternode");
  await expect(page.locator("#signInBox")).toBeHidden();
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 500 tDASH");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token", amount: 500, code: "masternode" }]);
});

test("a signed-in request skips the captcha and sends the CSRF token", async ({ page }) => {
  const headers = [];
  const requests = await openFaucet(page, {
    turnstile: "error-callback",
    amountLimits: LIMITS,
    headers,
    me: { authenticated: true, user: { email: "dev@dash.org" }, csrf: "csrf-1", providers: ["google"], loginOrigin: origin },
  });
  await page.locator("#amountInput").fill("1500");
  await expect(page.locator("#amountHint")).toContainText("Signed in as dev@dash.org");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, amount: 1500 }]);
  expect(headers[0]["x-csrf-token"]).toBe("csrf-1");
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test("a code refused for proof of work retries with Turnstile only", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "error-callback", amountLimits: LIMITS, responses: [
    { status: 400, json: { error: "Large amounts need the Turnstile captcha; proof of work is not enough", requiresTurnstile: true } },
  ] });
  await fillCode(page, "masternode");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Redeem code");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("needs the full captcha check");
  await expect(page.locator("#hardCapBox")).toBeHidden();
  expect(requests).toEqual([{ address: ADDRESS, capToken: "pow-1", code: "masternode" }]);

  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("need this check");
  expect(requests).toHaveLength(1);
  expect(await page.evaluate(() => window.powSolves)).toHaveLength(1);
});

test("a signed-in user redeeming a code goes through the captcha", async ({ page }) => {
  const headers = [];
  const requests = await openFaucet(page, {
    turnstile: "success",
    amountLimits: LIMITS,
    headers,
    me: { authenticated: true, user: { email: "dev@dash.org" }, csrf: "csrf-1", providers: ["google"], loginOrigin: origin },
  });
  await fillCode(page, "masternode");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Redeem code");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token", code: "masternode" }]);
  expect(headers[0]["x-csrf-token"]).toBeUndefined();
});

test("an unparseable amount is refused rather than sent as the default", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS });
  await page.locator("#amountInput").pressSequentially("1e");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("at least 0.001");
  expect(requests).toEqual([]);
});

test("a sign-in panel without a login URL hides its link", async ({ page }) => {
  await openFaucet(page, { turnstile: "success", amountLimits: LIMITS, me: { authenticated: false, providers: [] } });
  await page.locator("#amountInput").fill("500");
  await expect(page.locator("#signInBox")).toBeVisible();
  await expect(page.locator("#signInLink")).toBeHidden();
  await expect(page.locator("#signInDescription")).toHaveText("Use a voucher or event code.");
});

test("a hidden amount field never sends a prefilled amount", async ({ page }) => {
  const requests = await openFaucet(page, {
    turnstile: "success",
    network: "mainnet",
    query: "?amount=5",
    reserve: { coreFaucetAmount: 0.001, amountLimits: { turnstileAbove: 0.001, publicMax: 0.001, signedInMax: null } },
  });
  await expect(page.locator("#amountRow")).toBeHidden();
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 0.001 DASH");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: "Xp3oTrxmd5JL6qA1MKFDjkUeqgGXuRfGjv", turnstileToken: "web-token" }]);
});

test("the amount field labels the button, shows its tier and submits on Enter", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS, responses: [
    { json: { txid: "a".repeat(64), amount: 25, address: ADDRESS } },
  ] });
  await expect(page.locator("#amountRow")).toBeVisible();
  await expect(page.locator("#amountHint")).toHaveText("Up to 100 tDASH per request; more with a dash.org sign-in or a code.");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 1 tDASH");
  await page.locator("#amountInput").fill("25");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 25 tDASH");
  await page.locator("#amountInput").press("Enter");
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  await expect(page.locator("#coreSentAmount")).toHaveText(`25 tDASH to ${ADDRESS}`);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token", amount: 25 }]);
  await page.locator("#sendMoreBtn").click();
  await expect(page.locator("#amountInput")).toHaveValue("");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 1 tDASH");
});

test("Enter in the code field submits the request", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS });
  await fillCode(page, "dashcon-26");
  await page.locator("#codeInput").press("Enter");
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token", code: "dashcon-26" }]);
});
