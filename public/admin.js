"use strict";

(() => {
  const { el, date, dash, api } = Portal;
  const $ = (id) => document.getElementById(id);
  const EXPLORER = "https://insight.testnet.networks.dash.org/insight/tx/";

  function fail(error) {
    Portal.showError($("adminError"), error);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Run an admin action: clear the last error, show this one's if it fails. */
  async function run(action) {
    $("adminError").hidden = true;
    try {
      await action();
    } catch (error) {
      fail(error);
    }
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
    if (code.disabled) return el("span", { class: "badge off" }, "disabled");
    if (code.expiresAt && code.expiresAt <= Date.now()) return el("span", { class: "badge off" }, "expired");
    if (code.redemptions >= code.maxRedemptions) return el("span", { class: "badge off" }, "used up");
    return el("span", { class: "badge ok" }, "live");
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
    $("codeRows").replaceChildren(
      ...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 8, class: "empty" }, "No codes yet."))]),
    );
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
      $("detailRows").replaceChildren(
        ...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 4, class: "empty" }, "Not redeemed yet."))]),
      );
      $("detailDialog").showModal();
    });
  }

  // --- keys --------------------------------------------------------------------

  function keyStatus(key) {
    if (key.revokedAt) return el("span", { class: "badge off" }, "revoked");
    if (key.expiresAt && key.expiresAt <= Date.now()) return el("span", { class: "badge off" }, "expired");
    return el("span", { class: "badge ok" }, "active");
  }

  async function loadKeys() {
    const { keys } = await api("GET", "/api/admin/keys");
    const rows = keys
      .slice()
      .reverse()
      .map((key) => {
        const live = !key.revokedAt && !(key.expiresAt && key.expiresAt <= Date.now());
        return el("tr", {},
          el("td", {}, key.label, el("div", { class: "mono" }, key.id)),
          el("td", {}, key.ownerEmail || (key.owner ? key.owner : "— (minted)")),
          el("td", {}, el("span", { class: key.tier === "mn" ? "badge mn" : "badge" }, key.tier)),
          el("td", {}, date(key.createdAt)),
          el("td", {}, date(key.expiresAt)),
          el("td", {}, date(key.lastUsedAt)),
          el("td", {}, `${dash(key.paidSats)} (${key.payouts})`),
          el("td", {}, keyStatus(key)),
          el("td", {}, live
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
    $("allKeyRows").replaceChildren(
      ...(rows.length ? rows : [el("tr", {}, el("td", { colspan: 9, class: "empty" }, "No keys yet."))]),
    );
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
