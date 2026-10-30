"use strict";

(() => {
  const { el, fill, ago, date, dash, api, keyState, pill } = Portal;
  const $ = (id) => document.getElementById(id);
  const EXPLORER = "https://insight.testnet.networks.dash.org/insight/tx/";
  let kind = "event";
  let showRevoked = false;

  function run(action) {
    return Portal.run($("adminError"), action);
  }

  /** <input type=date> value → the end of that local day, or null when empty. */
  function expiry(input) {
    if (!input.value) return null;
    const [y, m, d] = input.value.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59).getTime();
  }

  function toDateInput(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** "google:pasta@dash.org" → "pasta@dash.org"; ids and the admin token as they are. */
  function actorName(actor) {
    if (!actor) return "";
    if (actor === "admin-token") return "the admin token";
    return actor.startsWith("google:") ? actor.slice("google:".length) : actor;
  }

  function shareLink(code) {
    return `${location.origin}/?code=${encodeURIComponent(code)}`;
  }

  // --- codes -------------------------------------------------------------------

  const KIND_HINTS = {
    event: "One code many people can type in, for a meetup or conference. Each address can use it once. Anyone can guess a short code, so give valuable ones a code that's hard to guess, or use vouchers.",
    voucher: "Single-use codes generated for you, to hand out one per person. Each comes with a link that opens the faucet with the code filled in.",
  };

  function setKind(next) {
    kind = next;
    $("kindEvent").setAttribute("aria-pressed", String(kind === "event"));
    $("kindVoucher").setAttribute("aria-pressed", String(kind === "voucher"));
    for (const field of document.querySelectorAll("[data-kind]")) field.hidden = field.dataset.kind !== kind;
    $("codeValue").required = kind === "event";
    $("kindHint").textContent = KIND_HINTS[kind];
    $("codeSubmit").textContent = kind === "event" ? "Create code" : "Generate vouchers";
  }

  function codeStatus(code) {
    if (code.disabled) return pill("disabled", "off");
    if (code.expiresAt && code.expiresAt <= Date.now()) return pill("expired", "off");
    if (code.redemptions >= code.maxRedemptions) return pill("used up", "warn");
    return pill("live", "ok");
  }

  function usage(code) {
    const pct = Math.min(100, Math.round((code.redemptions / code.maxRedemptions) * 100));
    const bar = el("div", { class: "bar" }, el("span", {}));
    bar.firstChild.style.width = `${pct}%`;
    const count = `${code.redemptions} of ${code.maxRedemptions}`;
    return [
      code.redemptions
        ? el("button", { class: "linklike", onclick: () => details(code), title: "Who redeemed it" }, count)
        : count,
      code.maxRedemptions > 1 ? bar : null,
    ];
  }

  async function loadCodes() {
    const { codes } = await api("GET", "/api/admin/codes");
    $("codeCount2").textContent = codes.length ? `${codes.length} in total` : "";
    const rows = codes.map((code) =>
      el("tr", {},
        el("td", {},
          el("span", { class: "mono" }, code.code),
          el("span", { class: "sub" }, `${code.label}${code.kind === "voucher" ? " (voucher)" : ""}`),
          el("span", { class: "sub" }, `by ${actorName(code.updatedBy || code.createdBy)}${code.updatedBy ? " (last change)" : ""}`)),
        el("td", {}, dash(code.amountSats)),
        el("td", { class: "usage" }, usage(code)),
        el("td", {}, code.expiresAt ? date(code.expiresAt) : "never"),
        el("td", {}, codeStatus(code)),
        el("td", { class: "actions" },
          el("button", { class: "ghost small", onclick: (e) => Portal.copy(shareLink(code.code), e.currentTarget) }, "Copy link"),
          el("button", { class: "ghost small", onclick: () => edit(code) }, "Edit"),
          el("button", {
            class: code.disabled ? "ghost small" : "danger small",
            onclick: () => patch(code, { disabled: !code.disabled }),
          }, code.disabled ? "Enable" : "Disable"),
        ),
      ),
    );
    fill($("codeRows"), rows.length ? rows : el("tr", {}, el("td", { colspan: 6, class: "empty" }, "No codes yet. Create one above.")));
  }

  function patch(code, changes) {
    return run(async () => {
      await api("PATCH", `/api/admin/codes/${code.id}`, changes);
      await loadCodes();
    });
  }

  function edit(code) {
    $("editTitle").textContent = `Edit ${code.code}`;
    $("editLabel").value = code.label;
    $("editAmount").value = code.amountSats / 1e8;
    $("editMax").value = code.maxRedemptions;
    const shownExpiry = toDateInput(code.expiresAt);
    $("editExpiry").value = shownExpiry;
    $("editForm").onsubmit = async (event) => {
      event.preventDefault();
      $("editDialog").close();
      await patch(code, {
        label: $("editLabel").value.trim(),
        amount: Number($("editAmount").value),
        maxRedemptions: Number($("editMax").value),
        // Only when the date was changed: re-sending it would move the expiry
        // to the end of that day in this admin's time zone.
        ...($("editExpiry").value !== shownExpiry ? { expiresAt: expiry($("editExpiry")) } : {}),
      });
    };
    $("editDialog").showModal();
  }

  function details(code) {
    return run(async () => {
      const { redemptions } = await api("GET", `/api/admin/codes/${code.id}`);
      $("detailTitle").textContent = `Redemptions of ${code.code}`;
      fill($("detailLink"), "Share link: ", el("span", { class: "mono" }, shareLink(code.code)));
      const rows = redemptions.map((r) =>
        el("tr", {},
          el("td", {}, ago(r.createdAt)),
          el("td", { class: "mono" }, r.address),
          el("td", {}, dash(r.satoshis)),
          el("td", { class: "mono" }, el("a", { href: EXPLORER + r.txid, target: "_blank", rel: "noopener noreferrer" }, `${r.txid.slice(0, 12)}…`)),
        ),
      );
      fill($("detailRows"), rows.length ? rows : el("tr", {}, el("td", { colspan: 4, class: "empty" }, "Nobody has used this code yet.")));
      $("detailDialog").showModal();
    });
  }

  function createCode(event) {
    event.preventDefault();
    run(async () => {
      const common = {
        label: $("codeLabel").value.trim(),
        amount: Number($("codeAmount").value),
        expiresAt: expiry($("codeExpiry")),
      };
      if (kind === "event") {
        await api("POST", "/api/admin/codes", {
          ...common,
          kind: "event",
          code: $("codeValue").value.trim(),
          maxRedemptions: Number($("codeMax").value),
        });
        $("codeValue").value = "";
      } else {
        const { codes } = await api("POST", "/api/admin/codes", {
          ...common,
          kind: "voucher",
          count: Number($("codeCount").value),
        });
        const text = codes.map((c) => `${c.code}  ${shareLink(c.code)}`).join("\n");
        $("newVoucherTitle").textContent = `${codes.length} voucher${codes.length === 1 ? "" : "s"} for ${dash(codes[0].amountSats)} each. They stay listed below.`;
        $("newVoucherList").textContent = text;
        $("newVouchers").hidden = false;
        $("copyVouchers").onclick = () => Portal.copy(text, $("copyVouchers"));
        $("newVouchers").scrollIntoView({ behavior: "smooth", block: "center" });
      }
      await loadCodes();
    });
  }

  // --- keys --------------------------------------------------------------------

  const TIER_NAMES = { mn: "Masternode", trusted: "Unlimited" };

  async function loadKeys() {
    const { keys } = await api("GET", "/api/admin/keys");
    const shown = keys.slice().reverse().filter((k) => showRevoked || keyState(k) === "active");
    const rows = shown.map((key) => {
      const state = keyState(key);
      return el("tr", {},
        el("td", {}, key.label, el("span", { class: "sub mono" }, key.id)),
        el("td", {}, key.ownerEmail || key.owner || el("span", { class: "muted" }, `minted by ${actorName(key.createdBy) || "an admin"}`)),
        el("td", {}, pill(TIER_NAMES[key.tier] || key.tier, key.tier === "mn" ? "warn" : "info")),
        el("td", {}, key.lastUsedAt ? ago(key.lastUsedAt) : "never"),
        el("td", {}, key.payouts ? `${dash(key.paidSats)} (${key.payouts})` : "—"),
        el("td", {},
          state === "active" ? pill("active", "ok") : pill(state, "off"),
          key.revokedBy
            ? el("span", { class: "sub" }, key.revokedBy === key.owner ? "by its owner" : `by ${actorName(key.revokedBy)}`)
            : null),
        el("td", { class: "actions" }, state === "active"
          ? el("button", {
              class: "danger small",
              onclick: () => {
                if (!confirm(`Revoke "${key.label}"${key.ownerEmail ? ` (${key.ownerEmail})` : ""}? It stops working right away.`)) return;
                return run(async () => {
                  await api("DELETE", `/api/admin/keys/${key.id}`);
                  await loadKeys();
                });
              },
            }, "Revoke")
          : null),
      );
    });
    fill($("allKeyRows"), rows.length ? rows : el("tr", {}, el("td", { colspan: 7, class: "empty" }, "No active keys.")));
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
      Portal.renderSignIn($("signIn"), "/admin", "Faucet admin", "Sign in to manage codes and API keys.");
      return;
    }
    if (!me.admin) {
      $("notAdmin").hidden = false;
      return;
    }
    $("panel").hidden = false;
    $("tabCodes").onclick = () => selectTab("codes");
    $("tabKeys").onclick = () => selectTab("keys");
    $("kindEvent").onclick = () => setKind("event");
    $("kindVoucher").onclick = () => setKind("voucher");
    $("editCancel").onclick = () => $("editDialog").close();
    $("detailClose").onclick = () => $("detailDialog").close();
    $("hideVouchers").onclick = () => { $("newVouchers").hidden = true; };
    $("hideMinted").onclick = () => { $("mintedKey").hidden = true; $("mintedValue").textContent = ""; };
    $("showRevoked").onchange = (e) => { showRevoked = e.target.checked; run(loadKeys); };
    $("codeForm").addEventListener("submit", createCode);

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
        $("mintedKey").scrollIntoView({ behavior: "smooth", block: "center" });
        await loadKeys();
      });
    });

    setKind("event");
    selectTab("codes");
  }

  main().catch((error) => {
    document.querySelector(".shell").append(el("div", { class: "error", role: "alert" }, `Couldn't load this page: ${error.message}`));
  });
})();
