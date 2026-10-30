// Shared by /keys and /admin. Every value from the server is rendered with
// textContent, never as HTML.
"use strict";

const Portal = (() => {
  let me = null;

  async function loadMe() {
    const res = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
    me = await res.json();
    return me;
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(me && me.csrf ? { "X-CSRF-Token": me.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    return data;
  }

  /** Text and nodes to append, minus null/undefined/false (which would render as "null"). */
  function nodes(children) {
    return children
      .flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== false)
      .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
  }

  /** el("td", { class: "mono" }, "text", childNode, ...) */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    node.append(...nodes(children));
    return node;
  }

  /** Replace a container's children, skipping empty entries. */
  function fill(container, ...children) {
    container.replaceChildren(...nodes(children));
  }

  function date(ms) {
    if (!ms) return "never";
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function ago(ms) {
    if (!ms) return "never";
    const minutes = Math.round((Date.now() - ms) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return date(ms);
  }

  function dash(sats) {
    return `${(sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} tDASH`;
  }

  /** "revoked" | "expired" | "active" for an API key. */
  function keyState(key) {
    if (key.revokedAt) return "revoked";
    if (key.expiresAt && key.expiresAt <= Date.now()) return "expired";
    return "active";
  }

  function pill(text, tone) {
    return el("span", { class: `pill pill-${tone}` }, text);
  }

  function showError(box, error) {
    box.textContent = error instanceof Error ? error.message : String(error);
    box.hidden = false;
  }

  /** Run a UI action: clear the last error, show this one's if it fails. */
  async function run(errorBox, action) {
    errorBox.hidden = true;
    try {
      await action();
    } catch (error) {
      showError(errorBox, error);
      errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  async function copy(text, button) {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copied";
    button.classList.add("is-done");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("is-done");
    }, 1600);
  }

  /** Who may sign in, in words, for the providers this server offers. */
  function eligibility() {
    const parts = [];
    if (me.providers.includes("google")) parts.push(`a verified @${me.emailDomain} Google account`);
    if (me.providers.includes("github")) {
      parts.push(`a GitHub account in the ${me.githubOrg} organization or with a verified @${me.emailDomain} address`);
    }
    return parts.join(", or ");
  }

  const LOGIN_ERRORS = {
    state: "That sign-in link expired or was opened in a different browser. Start again below.",
    denied: "Sign-in was cancelled. Start again when you're ready.",
    provider: "Google could not be reached. Try again in a moment.",
  };

  /** Top-bar identity: who you are, where else you can go, and sign out. */
  function renderWho(container) {
    if (!me || !me.authenticated) return fill(container);
    const who = me.user.provider === "github" ? `@${me.user.login}` : me.user.email;
    const here = location.pathname;
    fill(
      container,
      el("span", { class: "who-name", title: who }, who),
      me.admin && here !== "/admin" ? el("a", { href: "/admin" }, "Admin") : null,
      here !== "/keys" ? el("a", { href: "/keys" }, "My keys") : null,
      el("button", {
        class: "ghost small",
        onclick: async () => {
          await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
          location.href = "/keys";
        },
      }, "Sign out"),
    );
  }

  const PROVIDER_NAMES = { google: "Continue with Google", github: "Continue with GitHub" };

  function renderSignIn(container, returnTo, heading, lede) {
    const code = new URLSearchParams(location.search).get("error");
    const error = code === "domain"
      ? `That account can't sign in here. Use ${eligibility()}.`
      : LOGIN_ERRORS[code];
    fill(
      container,
      el("h1", {}, heading),
      el("p", { class: "lede" }, lede),
      error ? el("div", { class: "error", role: "alert" }, error) : null,
      me.providers.length === 0
        ? el("p", { class: "muted" }, "Sign-in isn't set up on this server yet.")
        : el("div", { class: "providers" },
            me.providers.map((p) =>
              el("a", { class: "button primary large", href: `/auth/${p}/login?return=${returnTo}` }, PROVIDER_NAMES[p] || p))),
      el("p", { class: "muted fine" }, `Open to anyone with ${eligibility() || "an eligible account"}.`),
    );
    container.hidden = false;
  }

  return { loadMe, api, el, fill, date, ago, dash, keyState, pill, showError, run, copy, renderWho, renderSignIn };
})();
