"use strict";

(() => {
  const { el, fill, ago, date, dash, api, keyState, pill, run } = Portal;
  const $ = (id) => document.getElementById(id);
  let maxKeys = 0;

  function usage(token) {
    return [
      `export DASH_FAUCET_KEY=${token}`,
      `curl -X POST ${location.origin}/api/core-faucet \\`,
      `  -H "Authorization: Bearer $DASH_FAUCET_KEY" \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '{"address":"y...","amount":10}'`,
    ].join("\n");
  }

  function act(action) {
    return run($("keysError"), action);
  }

  function showToken(token) {
    $("newKeyValue").textContent = token;
    $("newKeyUsage").textContent = usage(token);
    $("newKey").hidden = false;
    $("copyKey").onclick = () => Portal.copy(token, $("copyKey"));
    $("copySnippet").onclick = () => Portal.copy(usage(token), $("copySnippet"));
    $("hideKey").onclick = () => {
      $("newKey").hidden = true;
      $("newKeyValue").textContent = "";
      $("newKeyUsage").textContent = "";
    };
    $("newKey").scrollIntoView({ behavior: "smooth", block: "center" });
    $("copyKey").focus({ preventScroll: true });
  }

  function row(key) {
    const state = keyState(key);
    const live = state === "active";
    return el("li", { class: "key-row" },
      el("div", { class: "key-name" }, key.label, el("span", { class: "mono" }, key.id)),
      el("div", { class: "key-meta" },
        el("span", {}, `Created ${date(key.createdAt)}`),
        el("span", {}, key.lastUsedAt ? `Last used ${ago(key.lastUsedAt)}` : "Not used yet"),
        key.payouts ? el("span", {}, `${dash(key.paidSats)} paid out over ${key.payouts} request${key.payouts === 1 ? "" : "s"}`) : null,
        key.expiresAt && live ? el("span", {}, `Expires ${date(key.expiresAt)}`) : null,
      ),
      el("div", { class: "key-side" },
        live
          ? [
              el("button", { class: "ghost small", onclick: () => rotate(key), title: "Replace with a new value" }, "Rotate"),
              el("button", { class: "danger small", onclick: () => revoke(key) }, "Revoke"),
            ]
          : pill(state, "off"),
      ),
    );
  }

  function refresh() {
    return act(async () => {
      const { keys } = await api("GET", "/api/me/keys");
      const newest = keys.slice().reverse();
      const live = newest.filter((k) => keyState(k) === "active");
      const past = newest.filter((k) => keyState(k) !== "active");
      fill($("keyRows"), live.length ? live.map(row) : el("li", { class: "empty" }, "No active keys. Create one above."));
      $("keyCount").textContent = `${live.length} of ${maxKeys} allowed`;
      $("pastKeys").hidden = past.length === 0;
      $("pastSummary").textContent = `${past.length} revoked or expired key${past.length === 1 ? "" : "s"}`;
      fill($("pastRows"), past.map(row));
    });
  }

  function rotate(key) {
    if (!confirm(`Rotate "${key.label}"? You get a new value, and the current one stops working right away.`)) return;
    return act(async () => {
      const created = await api("POST", `/api/me/keys/${key.id}/rotate`);
      showToken(created.token);
      await refresh();
    });
  }

  function revoke(key) {
    if (!confirm(`Revoke "${key.label}"? Anything using it stops working right away.`)) return;
    return act(async () => {
      await api("DELETE", `/api/me/keys/${key.id}`);
      await refresh();
    });
  }

  async function main() {
    const me = await Portal.loadMe();
    Portal.renderWho($("who"));
    if (!me.authenticated) {
      Portal.renderSignIn(
        $("signIn"),
        "/keys",
        "Get a faucet API key",
        "Sign in to create keys that request testnet DASH for your scripts, CI and agents, with no captcha and no rate limits.",
      );
      return;
    }
    maxKeys = me.maxKeys;
    $("account").hidden = false;
    $("maxAmount").textContent = me.keyMaxPerRequest;
    $("usageExample").textContent = usage("dfk_…");
    $("createForm").addEventListener("submit", (event) => {
      event.preventDefault();
      act(async () => {
        const label = $("keyLabel").value.trim();
        const created = await api("POST", "/api/me/keys", label ? { label } : {});
        $("keyLabel").value = "";
        showToken(created.token);
        await refresh();
      });
    });
    await refresh();
  }

  main().catch((error) => {
    document.querySelector(".shell").append(el("div", { class: "error", role: "alert" }, `Couldn't load this page: ${error.message}`));
  });
})();
