import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { mainnetHomeRedirect } from "../../src/home.ts";

const origin = "https://faucet.test";
const ADDRESS = "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs";

async function fillCode(page, code) {
  await page.locator("#codeInput").fill(code);
}

// Exercise the shipped page with deterministic CAPTCHA providers and payouts.
// Worker tests separately solve and verify real CAP challenges and rate tiers.
async function openFaucet(page, { turnstile = "missing", network = "testnet", responses = [], statusResponses = [], invitation = false, query = "", reserve = {}, statusCode = 200, amountLimits, me, meResponse, headers = [], invitationResponse, blockShell = false, startPath } = {}) {
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
      if (meResponse) return meResponse(route);
      return route.fulfill({ json: me || { authenticated: false, providers: ["google"], loginOrigin: "https://login.test" } });
    }
    if (path === "/api/core-faucet") {
      requests.push(route.request().postDataJSON());
      headers.push(route.request().headers());
      return route.fulfill(responses.shift() || { json: { txid: "a".repeat(64), amount: 1 } });
    }
    if (path === "/api/invitation-faucet" && invitationResponse) return route.fulfill(invitationResponse());
    if (blockShell && path === "/dashhq/dashhq-shell.js") return route.abort();
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
  await page.goto(origin + (startPath ?? (invitation ? "/invitations" : "/")) + query);
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
  await page.locator('#addressInput').fill(ADDRESS);
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#coreFaucetCard')).toHaveClass(/success/);
  await expect(page.locator('#bridgeReturn')).toBeHidden();
});


test("shows an amber request action, invitation stock and both reserves before input", async ({ page }) => {
  const requests = await openFaucet(page);
  await page.locator('#addressInput').clear();
  await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
  await expect(page.locator('#coreFaucetBtn')).toHaveClass(/dh-btn--primary/);
  await expect(page.locator('#invitationEntry')).toBeVisible();
  await expect(page.locator('#invitationEntryAvailability')).toHaveText('1 invitation ready now');
  await expect(page.locator('#invitationEntry .description')).toHaveText('Get an invitation with 0.03 DASH for one identity and a non-contested name.');
  await expect(page.locator('#invitationEntry .invitation-steps li')).toHaveText(['Get an invitation here.', 'Open it in Dash Wallet.', 'Choose your name. The invitation pays for it.']);
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
  await expect(page.locator('#codeInput')).toBeVisible();
  await expect(page.locator('#coreFunding')).toBeHidden();
  await expect(page.locator('#coreNetworkWarning')).toHaveText('testnet DASH only');
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#addressValidation')).toHaveText('Enter a receiving address.');
  await expect(page.locator('#addressInput')).toBeFocused();
  await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
  expect(requests).toEqual([]);
});

test("submitting with unknown availability rechecks status and refuses only if it still fails", async ({ page }) => {
  const requests = await openFaucet(page, { statusResponses: [{ status: 503, json: {} }, { status: 503, json: {} }] });
  await expect(page.locator('#statusBar')).toContainText('Availability unknown');
  await page.locator('#addressInput').fill('yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs');
  await expect(page.locator('#coreFaucetBtn')).toBeEnabled();
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#coreErrorBox')).toContainText('Retry faucet status');
  expect(requests).toEqual([]);
});

test("submitting after a failed status check sends once a recheck succeeds", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", statusResponses: [{ status: 503, json: {} }] });
  await expect(page.locator('#statusBar')).toContainText('Availability unknown');
  await page.locator('#addressInput').fill(ADDRESS);
  await page.locator('#coreFaucetBtn').click();
  await expect(page.locator('#coreFaucetCard')).toHaveClass(/success/);
  await expect(page.locator('#statusBar')).toContainText('Faucet online');
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token" }]);
});

for (const [balance, expectedState] of [[1000, "good"], [999.99999999, "warn"], [0, "warn"]]) {
  test(`reserve coverage uses the daily budget at balance ${balance}`, async ({ page }) => {
    await openFaucet(page, { reserve: { balance, dailyBudgetSats: 100_000_000_000 } });
    await expect(page.locator("#coreReserve")).toHaveAttribute("data-state", expectedState);
    await expect(page.locator("#coreReserveCoverage")).toContainText("1,000 tDASH/day");
    await expect(page.locator("#invitationReserve")).toHaveAttribute("data-state", "good");
    await expect(page.locator("#invitationReserveCoverage")).toHaveText("1 invitation ready now · 0 preparing · 0 reserved");
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
  await expect(page.locator("#invitationHomeTreasuryCard")).toBeVisible();
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
  await expect(page.locator("#invitationReserve")).toBeVisible();
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
  await expect(page.locator("#coreFaucetBtn")).toBeDisabled();
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Sign in or add a code for 500 tDASH");
  await page.locator("#amountInput").press("Enter");
  await expect(page.locator("#coreErrorBox")).toContainText("dash.org sign-in or a code");
  expect(requests).toEqual([]);
  await page.locator("#amountInput").fill("100");
  await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 100 tDASH");
  await page.locator("#amountInput").fill("500");
  await expect(page.locator("#coreFaucetBtn")).toBeDisabled();

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
  await expect(page.locator("#signInBox")).toBeHidden();
  await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 1,500 tDASH");
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

test("the browser check accepts only pay-to-public-key-hash addresses", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success" });
  await expect(page.locator("#addressHint")).toHaveText("A testnet address starts with y.");
  for (const address of ["8eWmb1WDYYfnviGcfaTBZjftxGpCwriip5", "93m4hAxmCcGXMfnjVPfNhWSjb69sBgdWN2"]) {
    await page.locator("#addressInput").fill(address);
    await page.locator("#coreFaucetBtn").click();
    await expect(page.locator("#addressValidation")).toContainText("starting with y");
  }
  expect(requests).toEqual([]);
});

test("amounts with more than 8 decimals are refused before the label or the captcha", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS });
  await page.locator("#amountInput").fill("1.123456789");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get tDASH");
  await expect(page.locator("#amountHint")).toContainText("8 decimal places");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("8 decimal places");
  await page.locator("#amountInput").fill("1.12345678");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 1.12345678 tDASH");
  expect(requests).toEqual([]);
});

test("the sent transaction links to an Insight host that exists", async ({ page }) => {
  await openFaucet(page, { turnstile: "success" });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  await expect(page.locator("#coreTxid dashhq-hash")).toHaveAttribute("href", `https://insight.testnet.networks.dash.org/insight/tx/${"a".repeat(64)}`);
});

test("mainnet sends link to mainnet Insight and the status bar names Mainnet", async ({ page }) => {
  await openFaucet(page, { turnstile: "success", network: "mainnet", reserve: { status: "low_balance" }, statusCode: 503 });
  await expect(page.locator("#statusBar")).toContainText("Mainnet faucet low balance");
  await expect(page.locator("#statusBar")).toContainText("Mainnet block: 100");
  await expect(page.locator("#statusBar")).not.toContainText("Testnet");
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  await expect(page.locator("#coreTxid dashhq-hash")).toHaveAttribute("href", `https://insight.dash.org/insight/tx/${"a".repeat(64)}`);
});

test("the proof-of-work widget never sends the page URL off-site", async ({ page }) => {
  await openFaucet(page, { query: "?code=voucher-1" });
  expect(await page.evaluate(() => window.CAP_DISABLE_WIDGET_REF)).toBe(true);
});

test("a proof of work pays the request it was started for", async ({ page }) => {
  const requests = await openFaucet(page, { responses: [
    { status: 429, json: { error: "Rate limit exceeded", requiresHardCaptcha: true } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#capTitle")).toHaveText("Hourly limit reached");
  await page.locator("#addressInput").evaluate((input) => { input.value = "yfJZVF5WhFsVXCvqiR4JqAM3TmEf3LpPfw"; });
  await page.locator("cap-widget button").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests.map((request) => request.address)).toEqual([ADDRESS, ADDRESS]);
});

test("editing the payout cancels a pending proof of work", async ({ page }) => {
  const requests = await openFaucet(page, { responses: [
    { status: 429, json: { error: "Rate limit exceeded", requiresHardCaptcha: true } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#capTitle")).toHaveText("Hourly limit reached");
  await expect(page.locator("cap-widget")).toHaveCount(1);
  await page.locator("#addressInput").fill("yfJZVF5WhFsVXCvqiR4JqAM3TmEf3LpPfw");
  await expect(page.locator("cap-widget")).toHaveCount(0);
  await expect(page.locator("#hardCapBox")).not.toHaveClass(/visible/);
  await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  expect(requests).toHaveLength(1);
});

test("editing the payout during the captcha check stops the request", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "stall" });
  await page.clock.install();
  await page.locator("#coreFaucetBtn").click();
  await page.locator("#addressInput").fill("yfJZVF5WhFsVXCvqiR4JqAM3TmEf3LpPfw");
  await page.clock.fastForward(8100);
  await expect(page.locator("#coreErrorBox")).toContainText("request changed");
  await expect(page.locator("cap-widget")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("a pending session check settles before the captcha is chosen", async ({ page }) => {
  const headers = [];
  let releaseMe;
  const meReady = new Promise((resolve) => { releaseMe = resolve; });
  const requests = await openFaucet(page, {
    turnstile: "error-callback",
    amountLimits: LIMITS,
    headers,
    meResponse: async (route) => {
      await meReady;
      return route.fulfill({ json: { authenticated: true, user: { email: "dev@dash.org" }, csrf: "csrf-1", providers: ["google"], loginOrigin: origin } });
    },
  });
  await page.locator("#coreFaucetBtn").click();
  releaseMe();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS }]);
  expect(headers[0]["x-csrf-token"]).toBe("csrf-1");
  expect(await page.evaluate(() => window.powSolves)).toEqual([]);
});

test("a failed session check still allows a public request", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS, meResponse: (route) => route.abort() });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token" }]);
});

test("a replay still offers the way back to Bridge for the matching address", async ({ page }) => {
  await openFaucet(page, { turnstile: "success", query: `?from=bridge&journey=start&address=${ADDRESS}`, responses: [
    { json: { txid: "b".repeat(64), amount: 1, replay: true } },
  ] });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreErrorBox")).toContainText("already received");
  await expect(page.locator("#bridgeReturn")).toBeVisible();
});

test("the form still works when the shared shell script does not load", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = await openFaucet(page, { turnstile: "success", blockShell: true });
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token" }]);
  expect(errors).toEqual([]);
});

test("/invitations offers a retry after a failed status read", async ({ page }) => {
  await openFaucet(page, { invitation: true, statusResponses: [{ status: 503, json: {} }] });
  await expect(page.locator("#statusBar")).toContainText("Availability unknown");
  await page.locator("#retryStatusBtn").click();
  await expect(page.locator("#statusBar")).toContainText("Mainnet invitations");
  await expect(page.locator("#invitationCard")).toBeVisible();
  await expect(page.locator("#retryStatusBtn")).toBeHidden();
});

test("an expired invitation can no longer be opened or scanned", async ({ page }) => {
  await page.clock.install();
  await openFaucet(page, { invitation: true, turnstile: "success", invitationResponse: () => ({ json: {
    invitation: "dashwallet://invite?code=test", txid: "c".repeat(64), expiresAt: Date.now() + 5000,
  } }) });
  await page.locator("#invitationBtn").click();
  const link = page.locator("#invitationList a");
  await expect(link).toHaveAttribute("href", "dashwallet://invite?code=test");
  await expect(page.locator("#invitationList .invitation-qr")).toBeVisible();
  await page.clock.fastForward(6000);
  await expect(page.locator("#invitationExpiry")).toContainText("Reservation expired");
  await expect(link).not.toHaveAttribute("href");
  await expect(link).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#invitationList .invitation-qr")).toBeHidden();
});

test("the code field is visible before any click and a shared code fills it", async ({ page }) => {
  await openFaucet(page, { turnstile: "success", amountLimits: LIMITS, query: "?code=dashcon-26" });
  await expect(page.locator("#codeInput")).toBeVisible();
  await expect(page.locator("#codeInput")).toHaveValue("dashcon-26");
  await expect(page.locator("label[for=codeInput]")).toHaveText("Code optional");
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Redeem code");
});

test("both funding addresses show up front with their own Copy buttons", async ({ page }) => {
  const core = "yPrynRN6ViX2rCcRL5SoSi8ntcWgdHSEaS";
  const invitation = "Xm77DBJzsf6aMBSb25BAzTNxcjgvUECEeB";
  await page.addInitScript(() => {
    window.copiedFunding = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => window.copiedFunding.push(text) } });
  });
  const requests = await openFaucet(page, { reserve: { depositAddress: core, invitationDepositAddress: invitation, invitationInventory: { available: 3, preparing: 2, issued: 1 } } });
  await expect(page.locator("details")).toHaveCount(0);
  await expect(page.locator("#reserveSummary .reserve-intro")).toHaveText("Two networks, two separate treasuries. Fund the address for the service you want to support.");
  await expect(page.locator("#coreFunding .network-warning")).toHaveText("Send testnet DASH only to this address.");
  await expect(page.locator("#invitationHomeTreasuryCard .network-warning")).toHaveText("Send real mainnet DASH only to this address.");
  await expect(page.locator("#coreReserveNote")).toHaveText("1 tDASH per request");
  await expect(page.locator("#invitationReserveNote")).toHaveText("Spendable balance, separate from coins locked in invitations.");
  await expect(page.locator("#invitationReserveCoverage")).toHaveText("3 invitations ready now · 2 preparing · 1 reserved");
  await expect(page.locator("#invitationEntryAvailability")).toHaveText("3 invitations ready now");
  await page.locator("#coreFundingCopy").click();
  await expect(page.locator("#coreFundingCopy")).toHaveText("Copied");
  await page.locator("#invitationFundingCopy").click();
  await expect(page.locator("#invitationFundingCopy")).toHaveText("Copied");
  expect(await page.evaluate(() => window.copiedFunding)).toEqual([core, invitation]);
  expect(requests).toEqual([]);
});

test("a large amount waits for the session check before the button is ready", async ({ page }) => {
  let releaseMe;
  const meReady = new Promise((resolve) => { releaseMe = resolve; });
  await openFaucet(page, {
    turnstile: "success",
    amountLimits: LIMITS,
    meResponse: async (route) => {
      await meReady;
      return route.fulfill({ json: { authenticated: true, user: { email: "dev@dash.org" }, csrf: "csrf-1", providers: ["google"], loginOrigin: origin } });
    },
  });
  await page.locator("#amountInput").fill("500");
  await expect(page.locator("#coreFaucetBtn")).toBeDisabled();
  releaseMe();
  await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  await expect(page.locator("#coreFaucetBtn")).toHaveText("Get 500 tDASH");
});

test("Enter a code focuses the visible code field and unlocks the request", async ({ page }) => {
  const requests = await openFaucet(page, { turnstile: "success", amountLimits: LIMITS });
  await page.locator("#amountInput").fill("500");
  await expect(page.locator("#coreFaucetBtn")).toBeDisabled();
  await page.locator("#signInCodeBtn").click();
  await expect(page.locator("#codeInput")).toBeFocused();
  await page.keyboard.type("masternode");
  await expect(page.locator("#coreFaucetBtn")).toBeEnabled();
  await page.locator("#coreFaucetBtn").click();
  await expect(page.locator("#coreFaucetCard")).toHaveClass(/success/);
  expect(requests).toEqual([{ address: ADDRESS, turnstileToken: "web-token", amount: 500, code: "masternode" }]);
});

test("the API key card shows only when keys and sign-in are available", async ({ page }) => {
  await openFaucet(page, { amountLimits: LIMITS, reserve: { apiKeysEnabled: true } });
  await expect(page.locator("#devEntry")).toBeVisible();
  await expect(page.locator("#devEntry a")).toHaveAttribute("href", "/keys");
});

test("the API key card stays hidden without sign-in", async ({ page }) => {
  await openFaucet(page, { reserve: { apiKeysEnabled: true } });
  await expect(page.locator("#devEntry")).toBeHidden();
});

// The Worker's 302 itself is covered in test/worker/home.test.ts; this checks where it sends people.
test("/?network=mainnet is sent to the Mainnet invitations, keeping other parameters", async ({ page }) => {
  const target = new URL(mainnetHomeRedirect(new URL(`${origin}/?network=mainnet&from=bridge`)));
  expect(target.pathname + target.search).toBe("/invitations?from=bridge");
  await openFaucet(page, { invitation: true, startPath: target.pathname, query: target.search });
  await expect(page.locator("h1")).toHaveText("Mainnet identity invitations");
  await expect(page.locator("dashhq-bar")).toHaveAttribute("network", "mainnet");
  await expect(page.locator("#addressInput")).toHaveCount(0);
});

for (const query of ["?network=testnet", ""]) {
  test(`/${query} stays on the Testnet faucet`, async ({ page }) => {
    await openFaucet(page, { query });
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.locator("h1")).toHaveText("Get testnet DASH");
    await expect(page.locator("dashhq-bar")).toHaveAttribute("network", "testnet");
  });
}

test("the invitations status line sits inside its sources block, not above an empty gap", async ({ page }) => {
  await openFaucet(page, { invitation: true });
  const block = page.locator(".dh-sources");
  await expect(block).toHaveCount(1);
  await expect(block.locator("#statusBar")).toHaveText("Mainnet invitations");
  await expect(block.locator("#statusSource")).toHaveText("Just now");
  const [status, source] = await Promise.all([page.locator("#statusBar").boundingBox(), page.locator("#statusSource").boundingBox()]);
  const gap = source.y >= status.y + status.height ? source.y - (status.y + status.height) : 0;
  expect(gap).toBeLessThan(16);
});
