"use strict";

(() => {
  const { el, date, dash, api, keyState, badge, fillRows } = Portal;
  const $ = (id) => document.getElementById(id);
  const EXPLORER = "https://insight.testnet.networks.dash.org/insight/tx/";

  function run(action) {
    return Portal.run($("adminError"), action);
  }

  /** datetime-local value → epoch ms, or null when blank. */
  function expiry(input) {
    return input.value ? new Date(input.value).getTime() : null;
  }

  function toLocalInput(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function redeemLink(code) {
    return `${location.origin}/?code=${encodeURIComponent(code)}`;
  }

  // --- codes -------------------------------------------------------------------

  function codeStatus(code) {
    if (code.disabled) return badge("disabled", false);
    if (code.expiresAt && code.expiresAt <= Date.now()) return badge("expired", false);
    if (code.redemptions >= code.maxRedemptions) return badge("used up", false);
    return badge("live", true);
  }

  async function loadCodes() {
    const { codes } = await api("GET", "/api/admin/codes");
    const rows = codes.map((code) =>
      el("tr", {},
        el("td", { class: "mono" }, code.code),
        el("td", {}, code.label),
        el("td", {}, code.kind),
        el("td", {}, dash(code.amountSats)),
        el("td", {}, `${code.redemptions} / ${code.maxRedemptions}`),
        el("td", {}, date(code.expiresAt)),
        el("td", {}, codeStatus(code)),
        el("td", {}, el("div", { class: "actions" },
          el("button", { class: "secondary small", onclick: () => details(code) }, "Details"),
          el("button", { class: "secondary small", onclick: () => edit(code) }, "Edit"),
          el("button", {
            class: code.disabled ? "small" : "danger small",
            onclick: () => patch(code, { disabled: !code.disabled }),
          }, code.disabled ? "Enable" : "Disable"),
        )),
      ),
    );
    fillRows($("codeRows"), rows, 8, "No codes yet.");
  }

  function patch(code, changes) {
    return run(async () => {
      await api("PATCH", `/api/admin/codes/${code.id}`, changes);
      await loadCodes();
    });
  }

  function edit(code) {
    $("editCode").textContent = code.code;
    $("editLabel").value = code.label;
    $("editAmount").value = code.amountSats / 1e8;
    $("editMax").value = code.maxRedemptions;
    $("editExpiry").value = toLocalInput(code.expiresAt);
    $("editForm").onsubmit = async (event) => {
      event.preventDefault();
      $("editDialog").close();
      await patch(code, {
        label: $("editLabel").value.trim(),
        amount: Number($("editAmount").value),
        maxRedemptions: Number($("editMax").value),
        expiresAt: expiry($("editExpiry")),
      });
    };
    $("editDialog").showModal();
  }

  function details(code) {
    return run(async () => {
      const { redemptions } = await api("GET", `/api/admin/codes/${code.id}`);
      $("detailCode").textContent = code.code;
      $("detailLink").replaceChildren("Share link: ", el("span", { class: "mono" }, redeemLink(code.code)));
      const rows = redemptions.map((r) =>
        el("tr", {},
          el("td", {}, date(r.createdAt)),
          el("td", { class: "mono" }, r.address),
          el("td", {}, dash(r.satoshis)),
          el("td", { class: "mono" }, el("a", { href: EXPLORER + r.txid, target: "_blank", rel: "noopener noreferrer" }, `${r.txid.slice(0, 16)}…`)),
        ),
      );
      fillRows($("detailRows"), rows, 4, "Not redeemed yet.");
      $("detailDialog").showModal();
    });
  }

  // --- keys --------------------------------------------------------------------

  async function loadKeys() {
    const { keys } = await api("GET", "/api/admin/keys");
    const rows = keys
      .slice()
      .reverse()
      .map((key) => {
        const state = keyState(key);
        return el("tr", {},
          el("td", {}, key.label, el("div", { class: "mono" }, key.id)),
          el("td", {}, key.ownerEmail || key.owner || "— (minted)"),
          el("td", {}, el("span", { class: key.tier === "mn" ? "badge mn" : "badge" }, key.tier)),
          el("td", {}, date(key.createdAt)),
          el("td", {}, date(key.expiresAt)),
          el("td", {}, date(key.lastUsedAt)),
          el("td", {}, `${dash(key.paidSats)} (${key.payouts})`),
          el("td", {}, badge(state, state === "active")),
          el("td", {}, state === "active"
            ? el("button", {
                class: "danger small",
                onclick: () => {
                  if (!confirm(`Revoke "${key.label}"${key.ownerEmail ? ` (${key.ownerEmail})` : ""}?`)) return;
                  return run(async () => {
                    await api("DELETE", `/api/admin/keys/${key.id}`);
                    await loadKeys();
                  });
                },
              }, "Revoke")
            : null),
        );
      });
    fillRows($("allKeyRows"), rows, 9, "No keys yet.");
  }

  // --- wiring --------------------------------------------------------------------

  function selectTab(name) {
    $("tabCodes").setAttribute("aria-selected", String(name === "codes"));
    $("tabKeys").setAttribute("aria-selected", String(name === "keys"));
    $("codesPane").hidden = name !== "codes";
    $("keysPane").hidden = name !== "keys";
    run(name === "codes" ? loadCodes : loadKeys);
  }

  async function main() {
    const me = await Portal.loadMe();
    Portal.renderWho($("who"));
    if (!me.authenticated) {
      Portal.renderSignIn($("signIn"), "/admin");
      $("signIn").hidden = false;
      return;
    }
    if (!me.admin) {
      $("notAdmin").hidden = false;
      return;
    }
    $("panel").hidden = false;
    $("tabCodes").onclick = () => selectTab("codes");
    $("tabKeys").onclick = () => selectTab("keys");
    $("editCancel").onclick = () => $("editDialog").close();
    $("detailClose").onclick = () => $("detailDialog").close();

    $("eventForm").addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        await api("POST", "/api/admin/codes", {
          kind: "event",
          code: $("eventCode").value.trim(),
          label: $("eventLabel").value.trim(),
          amount: Number($("eventAmount").value),
          maxRedemptions: Number($("eventMax").value),
          expiresAt: expiry($("eventExpiry")),
        });
        $("eventForm").reset();
        await loadCodes();
      });
    });

    $("voucherForm").addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        const { codes } = await api("POST", "/api/admin/codes", {
          kind: "voucher",
          count: Number($("voucherCount").value),
          label: $("voucherLabel").value.trim(),
          amount: Number($("voucherAmount").value),
          expiresAt: expiry($("voucherExpiry")),
        });
        const text = codes.map((c) => `${c.code}  ${redeemLink(c.code)}`).join("\n");
        $("newVoucherList").textContent = text;
        $("newVouchers").hidden = false;
        $("copyVouchers").onclick = () => Portal.copy(text, $("copyVouchers"));
        await loadCodes();
      });
    });

    $("mintForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const perDay = $("mintPerDay").value;
      run(async () => {
        const created = await api("POST", "/api/admin/keys", {
          label: $("mintLabel").value.trim(),
          tier: $("mintTier").value,
          ...(perDay ? { perDay: Number(perDay) } : {}),
        });
        $("mintedValue").textContent = created.token;
        $("mintedKey").hidden = false;
        $("copyMinted").onclick = () => Portal.copy(created.token, $("copyMinted"));
        $("mintForm").reset();
        await loadKeys();
      });
    });

    selectTab("codes");
  }

  main().catch((error) => {
    document.body.append(el("div", { class: "error" }, `Could not load: ${error.message}`));
  });
})();
