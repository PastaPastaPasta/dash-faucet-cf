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

  /** el("td", { class: "mono" }, "text", childNode, ...) */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function date(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function dash(sats) {
    return `${(sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} tDASH`;
  }

  function showError(box, error) {
    box.textContent = error instanceof Error ? error.message : String(error);
    box.hidden = false;
  }

  async function copy(text, button) {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = label; }, 1500);
  }

  const LOGIN_ERRORS = {
    state: "The sign-in link expired or was opened in another browser. Please try again.",
    denied: "Sign-in was cancelled.",
    provider: "The sign-in provider could not be reached. Please try again.",
    domain: "Only verified @dash.org accounts, or members of the dashpay GitHub organization, can sign in.",
  };

  /** Header identity line with a sign-out button. */
  function renderWho(container) {
    container.replaceChildren();
    if (!me || !me.authenticated) return;
    const who = me.user.provider === "github" ? `@${me.user.login} (GitHub)` : me.user.email;
    // Through el(), which drops the null entries: append() would print them.
    container.append(...el("div", {},
      el("span", {}, "Signed in as ", el("strong", {}, who)),
      me.admin && location.pathname !== "/admin" ? el("a", { href: "/admin" }, "Admin") : null,
      location.pathname !== "/keys" ? el("a", { href: "/keys" }, "My keys") : null,
      el("button", {
        class: "secondary small",
        onclick: async () => {
          await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
          location.href = "/keys";
        },
      }, "Sign out"),
    ).childNodes);
  }

  function renderSignIn(container, returnTo) {
    const params = new URLSearchParams(location.search);
    const error = LOGIN_ERRORS[params.get("error")];
    const names = { google: "Sign in with Google (dash.org)", github: "Sign in with GitHub" };
    container.replaceChildren(
      el("h2", {}, "Sign in"),
      el("p", { class: "note" },
        `Anyone with a verified @${me.emailDomain} Google account, or a GitHub account that is a member of `,
        `the ${me.githubOrg} organization (or has a verified @${me.emailDomain} address), can sign in and `,
        "create their own API keys."),
      error ? el("div", { class: "error" }, error) : null,
      me.providers.length === 0
        ? el("p", { class: "empty" }, "Sign-in is not configured on this server yet.")
        : el("div", { class: "providers" },
            me.providers.map((p) => el("a", { class: "btn", href: `/auth/${p}/login?return=${returnTo}` }, names[p] || p))),
    );
  }

  return { loadMe, api, el, date, dash, showError, copy, renderWho, renderSignIn, get me() { return me; } };
})();
