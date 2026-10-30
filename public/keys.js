"use strict";

(() => {
  const { el, date, dash, api, keyState, badge, fillRows, run } = Portal;
  const $ = (id) => document.getElementById(id);

  function usage(token) {
    return [
      `export DASH_FAUCET_KEY=${token}`,
      `curl -X POST ${location.origin}/api/core-faucet \\`,
      `  -H "Authorization: Bearer $DASH_FAUCET_KEY" \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '{"address":"y...","amount":10}'`,
    ].join("\n");
  }

  function showToken(token) {
    $("newKeyValue").textContent = token;
    $("newKeyUsage").textContent = usage(token);
    $("newKey").hidden = false;
    $("copyKey").onclick = () => Portal.copy(token, $("copyKey"));
    $("hideKey").onclick = () => {
      $("newKey").hidden = true;
      $("newKeyValue").textContent = "";
      $("newKeyUsage").textContent = "";
    };
    $("newKey").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function act(action) {
    return run($("keysError"), action);
  }

  function refresh() {
    return act(async () => {
      const { keys } = await api("GET", "/api/me/keys");
      const rows = keys
        .slice()
        .reverse()
        .map((key) => {
          const state = keyState(key);
          return el("tr", {},
            el("td", {}, key.label),
            el("td", { class: "mono" }, key.id),
            el("td", {}, date(key.createdAt)),
            el("td", {}, date(key.expiresAt)),
            el("td", {}, date(key.lastUsedAt)),
            el("td", {}, `${dash(key.paidSats)} (${key.payouts})`),
            el("td", {}, badge(state, state === "active")),
            el("td", {}, state === "active"
              ? el("div", { class: "actions" },
                  el("button", { class: "secondary small", onclick: () => rotate(key) }, "Rotate"),
                  el("button", { class: "danger small", onclick: () => revoke(key) }, "Revoke"))
              : null),
          );
        });
      fillRows($("keyRows"), rows, 8, "No keys yet.");
    });
  }

  function rotate(key) {
    if (!confirm(`Replace "${key.label}" with a new key? The old one stops working immediately.`)) return;
    return act(async () => {
      const created = await api("POST", `/api/me/keys/${key.id}/rotate`);
      showToken(created.token);
      await refresh();
    });
  }

  function revoke(key) {
    if (!confirm(`Revoke "${key.label}"? Anything using it stops working immediately.`)) return;
    return act(async () => {
      await api("DELETE", `/api/me/keys/${key.id}`);
      await refresh();
    });
  }

  async function main() {
    const me = await Portal.loadMe();
    Portal.renderWho($("who"));
    if (!me.authenticated) {
      Portal.renderSignIn($("signIn"), "/keys");
      $("signIn").hidden = false;
      return;
    }
    $("account").hidden = false;
    $("keyRules").textContent =
      `Keys are tied to your account and last ${me.keyTtlDays} days; rotate one to get a fresh value and expiry. ` +
      `You can hold up to ${me.maxKeys} active keys. A key can request up to ${me.keyMaxPerRequest} tDASH per call.`;
    $("usageExample").textContent = usage("dfk_…");
    $("createForm").addEventListener("submit", (event) => {
      event.preventDefault();
      act(async () => {
        const created = await api("POST", "/api/me/keys", { label: $("keyLabel").value.trim() });
        $("keyLabel").value = "";
        showToken(created.token);
        await refresh();
      });
    });
    await refresh();
  }

  main().catch((error) => {
    document.body.append(el("div", { class: "error" }, `Could not load: ${error.message}`));
  });
})();
