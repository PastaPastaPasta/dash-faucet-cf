
        import { addressError } from "/address.js";
        import { bridgeReturnUrl } from "/bridge-return.js";
        import { reserveCoverage } from "/reserve-status.js";
        import { renderSVG } from "/vendor/uqr.mjs";

        "use strict";

        const NETWORK_COPY = {
            testnet: {
                coin: "tDASH",
                sent: "tDASH sent",
                placeholder: "y… address",
            },
            mainnet: {
                coin: "DASH",
                sent: "DASH sent",
                placeholder: "X… address",
            },
        };
        const BRIDGE_START = window.dashhq?.href
            ? dashhq.href("bridge", "/?mode=create&journey=start", { network: "testnet" })
            : "https://bridge.thepasta.org/?mode=create&journey=start&network=testnet";

        /**
         * @cap.js/widget, pinned by exact version and subresource integrity.
         *
         * Hand-rolling the browser solver is not an option: the escalated
         * challenge is ~839M hashes, so it has to run off the main thread. The
         * widget ships a WASM solver and a Web Worker pool that do exactly that,
         * and it already speaks this faucet's wire protocol — same
         * challenge/redeem paths, same token/solutions/success fields.
         */
        window.CAP_CUSTOM_WASM_URL = new URL("/vendor/cap_wasm_bg.wasm", location.href).href;
        window.CAP_PAKO_URL = "/vendor/pako_inflate.min.js";
        window.CAP_DISABLE_WIDGET_REF = true;
        const CAP_WIDGET_SRC = "/vendor/cap.min.js";
        const CAP_WIDGET_SRI =
            "sha384-jRVyBEwWeNAitIjhGT4Es7NBrYJS0WspXxvwUaxOve885Bj6sLTieyvmS85d9WF0";

        let faucetNetwork = "testnet";
        let coinName = "tDASH";
        let turnstileSiteKey = "";
        const turnstileWidgetIds = { core: null, invitation: null };
        let capEndpoint = "";
        let hardCapEndpoint = "";
        let capScriptPromise = null;
        let capWidget = null;
        /** True while the widget's worker pool is solving a challenge. */
        let capSolving = false;
        let coreRequestPending = false;
        let statusReady = false;
        let statusFailed = false;
        let statusPromise = null;
        let sessionPromise = null;
        /** The address, amount and code as submitted; an edit clears it. */
        let pendingRequest = null;
        let lastStatusSuccess;
        let invitationExpiryTimer = null;
        /** From /api/status: `{ turnstileAbove, publicMax, signedInMax }` in DASH. */
        let amountLimits = null;
        let defaultAmount = 1;
        /** `{ email, csrf }` when signed in on this host; such requests skip the captcha. */
        let session = null;
        let sessionChecking = false;
        let signInUrl = "";
        let canSignIn = false;
        /** Set once the server refused proof of work for this amount. */
        let needTurnstile = false;

        const invitationPage = /\/invitations(?:\.html)?\/?$/.test(location.pathname);
        const entryParams = new URLSearchParams(location.search);
        const returnUrl = bridgeReturnUrl(entryParams, BRIDGE_START);
        let addressTouched = false;

        const $ = (id) => document.getElementById(id);
        if (returnUrl && !invitationPage && $("journeyBand")) $("journeyBand").hidden = false;

        async function validateAddressInput() {
            const input = $("addressInput");
            const value = input.value.trim();
            let error;
            try { error = await addressError(value, faucetNetwork); }
            catch { error = "Address checking is unavailable. Reload this page to try again."; }
            if (input.value.trim() !== value) return false;
            input.setAttribute("aria-invalid", String(Boolean(error && addressTouched)));
            $("addressValidation").textContent = addressTouched && error ? (value ? error : "Enter a receiving address.") : "";
            $("addressValidation").toggleAttribute("data-invalid", Boolean(error && addressTouched));
            updateButtonState();
            return !error;
        }

        /** The requested amount: null for the default, NaN when unusable. */
        function requestedAmount() {
            const input = $("amountInput");
            // A number input reads "" for text it cannot parse, e.g. "1e".
            if (input.validity.badInput) return NaN;
            const text = input.value.trim();
            if (!text) return null;
            const amount = Number(text);
            const sats = amount * 1e8;
            return Number.isFinite(amount) && amount >= 0.001 && Math.abs(sats - Math.round(sats)) <= 1e-3 ? amount : NaN;
        }

        function formatAmount(value) {
            return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
        }

        /** True while the amount is above the public maximum with no sign-in and no code. */
        function signInRequired() {
            const amount = requestedAmount();
            return !session && !$("codeInput").value.trim() && !!amountLimits && !$("amountRow").hidden &&
                amount !== null && amount > amountLimits.publicMax;
        }

        function updateButtonState() {
            $("coreFaucetBtn").disabled = coreRequestPending || capSolving || signInRequired();
        }

        function updateSendLabel() {
            const amount = requestedAmount();
            const code = $("codeInput").value.trim();
            let label = `Get ${coinName}`;
            if (sessionChecking && signInRequired()) label = "Checking sign-in…";
            else if (signInRequired()) label = `Sign in or add a code for ${formatAmount(amount)} ${coinName}`;
            else if (code && amount === null) label = "Redeem code";
            else if (amount === null && defaultAmount > 0) label = `Get ${formatAmount(defaultAmount)} ${coinName}`;
            else if (amount > 0) label = `Get ${formatAmount(amount)} ${coinName}`;
            $("coreFaucetBtn").querySelector(".btn-text").textContent = label;
            updateButtonState();
        }

        function showSignIn(visible) {
            $("signInBox").hidden = !visible;
            $("signInLink").hidden = !signInUrl;
            if (signInUrl) $("signInLink").href = signInUrl;
            $("signInDescription").textContent = signInUrl
                ? "Sign in with your dash.org account, or use a voucher or event code."
                : "Use a voucher or event code.";
        }

        function setAmountHint(text, tone) {
            const hint = $("amountHint");
            hint.textContent = text;
            if (tone) hint.dataset.tone = tone;
            else delete hint.dataset.tone;
        }

        function updateAmountHint() {
            const amount = requestedAmount();
            const code = $("codeInput").value.trim();
            showSignIn(false);
            updateSendLabel();
            $("amountInput").setAttribute("aria-invalid", String(Number.isNaN(amount)));
            if (Number.isNaN(amount)) {
                setAmountHint("Enter at least 0.001, with at most 8 decimal places.", "bad");
                return;
            }
            if (session && !code) {
                const max = amountLimits?.signedInMax;
                setAmountHint(`Signed in as ${session.email} · no captcha` +
                    (max ? `, up to ${max.toLocaleString()} ${coinName}` : ""), "good");
                return;
            }
            if (!amountLimits || $("amountRow").hidden) {
                setAmountHint("");
            } else if (amount !== null && amount > amountLimits.publicMax) {
                const limit = `Amounts above ${formatAmount(amountLimits.publicMax)} ${coinName} need a dash.org sign-in or a code`;
                $("signInTitle").textContent = `${limit}.`;
                setAmountHint(code ? `${limit}. Your code sets the most it pays.` : sessionChecking ? "Checking your dash.org sign-in…" : "");
                showSignIn(!code && !sessionChecking);
            } else if (amount !== null && amount > amountLimits.turnstileAbove) {
                setAmountHint(`Amounts above ${formatAmount(amountLimits.turnstileAbove)} ${coinName} need a full captcha check.`);
            } else {
                const ceiling = amountLimits.publicMax > defaultAmount
                    ? `Up to ${formatAmount(amountLimits.publicMax)} ${coinName} per request`
                    : `${formatAmount(defaultAmount)} ${coinName} per request`;
                setAmountHint(`${ceiling}; more with ${canSignIn ? "a dash.org sign-in or " : ""}a code.`);
            }
        }

        /** Who is signed in here, and where to sign in otherwise. Cookies are host-only. */
        async function loadSession() {
            sessionChecking = true;
            updateAmountHint();
            try {
                const response = await fetch("/api/me", { credentials: "same-origin", signal: AbortSignal.timeout(8000) });
                const me = await response.json();
                if (me.authenticated && me.csrf) {
                    session = { email: me.user.email, csrf: me.csrf };
                } else {
                    session = null;
                    const provider = (me.providers || [])[0];
                    signInUrl = me.loginOrigin && provider
                        ? `${me.loginOrigin}/auth/${provider}/login?return=/`
                        : "";
                }
            } catch {
                session = null;
            }
            sessionChecking = false;
            updateAmountHint();
        }

        function showError(message) {
            const errorBox = $("coreErrorBox");
            errorBox.textContent = message;
            errorBox.classList.add("visible");
        }

        function hideHardCaptcha() {
            $("hardCapBox").classList.remove("visible");
            $("hardCapProgress").textContent = "";
        }

        /**
         * Tear the widget down once the token it produced has been presented.
         *
         * A capToken is single-use, but the widget keeps its solved token in an
         * internal cache and re-emits it on the next `solve()` rather than
         * fetching a fresh challenge — `reset()` clears the form value, not that
         * cache. Rebuilding is the only way to be sure the next escalation
         * solves something the server has not already burned.
         */
        function disposeCapWidget() {
            capSolving = false;
            if (!capWidget) return;
            capWidget = null;
            $("hardCapHolder").replaceChildren();
        }

        /**
         * Fetch the widget on first need only.
         *
         * Turnstile is the default path and is both stronger and cheaper in a
         * browser, so a visitor whose CAPTCHA succeeds below the limit need not pay
         * for a third-party script — nor for the WASM blob it pulls in behind
         * it. A failed load clears the promise so a later attempt can retry.
         */
        function loadCapWidgetScript() {
            if (capScriptPromise) return capScriptPromise;
            capScriptPromise = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = CAP_WIDGET_SRC;
                script.integrity = CAP_WIDGET_SRI;
                script.crossOrigin = "anonymous";
                script.async = true;
                script.onload = resolve;
                script.onerror = () => {
                    capScriptPromise = null;
                    reject(new Error("Could not load the extra challenge — please reload the page"));
                };
                document.head.appendChild(script);
            });
            return capScriptPromise;
        }

        /**
         * Use a short automatic solve when Turnstile fails on testnet. The hard
         * tier still requires a click before spending a minute of the user's CPU.
         */
        async function showPowCaptcha(tier = "hard", autoStart = false) {
            const progress = $("hardCapProgress");
            $("hardCapBox").classList.add("visible");
            if (capWidget) return;
            $("capTitle").textContent = tier === "hard"
                ? "Hourly limit reached" : "Verifying with proof of work";
            $("capDescription").textContent = tier === "hard"
                ? "Solve a longer proof-of-work challenge to keep going. It runs in the background and takes roughly 30–90 seconds; leave this tab open."
                : "A short proof-of-work challenge replaces the CAPTCHA. " +
                    (autoStart ? "It runs automatically; leave this tab open." : "Click the challenge below to try again.");

            const request = pendingRequest;
            progress.textContent = "Loading challenge…";
            await loadCapWidgetScript();
            await customElements.whenDefined("cap-widget");
            if (!request || pendingRequest !== request || capWidget) {
                if (!capWidget) hideHardCaptcha();
                return;
            }

            const widget = document.createElement("cap-widget");
            capWidget = widget;
            capWidget.setAttribute("data-cap-api-endpoint", tier === "hard" ? hardCapEndpoint : capEndpoint);
            // Leave one core free so the page stays responsive mid-solve.
            capWidget.setAttribute(
                "data-cap-worker-count",
                String(Math.max(1, (navigator.hardwareConcurrency || 4) - 1))
            );
            // A minute of silence reads as a hang, so mirror the widget's own
            // progress into text next to it.
            capWidget.addEventListener("progress", (event) => {
                const pct = Math.round((event.detail && event.detail.progress) || 0);
                // The widget has no "started" event; its first progress tick is
                // the signal to lock the form. Without that, an impatient second
                // click on Send would hide this panel and abandon a solve that
                // is still running in the worker pool.
                capSolving = true;
                $("coreFaucetBtn").disabled = true;
                progress.textContent = `Solving proof of work… ${pct}%`;
            });
            capWidget.addEventListener("error", (event) => {
                capSolving = false;
                void validateAddressInput();
                progress.textContent = "";
                showError(
                    (event.detail && event.detail.message) ||
                        "Challenge failed — please try again"
                );
            });
            capWidget.addEventListener("solve", (event) => {
                if (capWidget !== widget) return;
                capSolving = false;
                progress.textContent = "Solved — sending…";
                requestCoreFaucet({ capToken: event.detail.token }, tier);
            });

            $("hardCapHolder").appendChild(capWidget);
            progress.textContent = "";
            if (autoStart) {
                capSolving = true;
                $("coreFaucetBtn").disabled = true;
                // The widget reports solve failures through its error event.
                void capWidget.solve();
            }
        }

        function clearTurnstile(kind) {
            const id = turnstileWidgetIds[kind];
            turnstileWidgetIds[kind] = null;
            if (id !== null && window.turnstile) {
                try { window.turnstile.remove(id); } catch { /* Already unavailable. */ }
            }
        }

        /**
         * Resolve a Turnstile token, rendering the widget on first use.
         * Testnet falls back quickly if Turnstile needs interaction or stalls,
         * unless `strict`: large amounts take Turnstile or nothing.
         */
        function solveTurnstile(kind = "core", strict = false) {
            const invitation = kind === "invitation";
            if (strict && !turnstileSiteKey) {
                return Promise.reject(new Error("The captcha this amount needs is not configured"));
            }
            if (!turnstileSiteKey) {
                return invitation
                    ? Promise.reject(new Error("Invitation captcha is not configured"))
                    : Promise.resolve(null);
            }
            if (typeof window.turnstile === "undefined") {
                return Promise.reject(new Error("Captcha failed to load — please reload the page"));
            }

            return new Promise((resolve, reject) => {
                let settled = false;
                const settle = (fn, value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    fn(value);
                };
                const canFallback = !invitation && !strict && !!capEndpoint;
                const timer = setTimeout(
                    () => settle(reject, new Error("Captcha timed out — please try again")),
                    canFallback ? 8000 : 60000
                );

                const opts = {
                    sitekey: turnstileSiteKey,
                    execution: "execute",
                    appearance: "interaction-only",
                    callback: (token) => settle(resolve, token),
                    "error-callback": () =>
                        settle(reject, new Error("Captcha failed — please try again")),
                    "timeout-callback": () =>
                        settle(reject, new Error("Captcha timed out — please try again")),
                    "expired-callback": () =>
                        settle(reject, new Error("Captcha expired — please try again")),
                    "unsupported-callback": () =>
                        settle(reject, new Error("Captcha is not supported")),
                };
                if (invitation) opts.action = "invitation_faucet";
                if (canFallback) {
                    opts["before-interactive-callback"] = () =>
                        settle(reject, new Error("Using proof of work"));
                }

                try {
                    clearTurnstile(kind);
                    const holder = invitation
                        ? $("invitationTurnstileHolder")
                        : $("turnstileHolder");
                    turnstileWidgetIds[kind] = window.turnstile.render(holder, opts);
                    if (!settled) window.turnstile.execute(turnstileWidgetIds[kind], opts);
                } catch (error) {
                    settle(reject, error);
                }
            });
        }

        function updateInvitationCountdown(expiresAt) {
            const expiry = $("invitationExpiry");
            const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
            if (remaining > 0) {
                expiry.textContent = `Reserved for you for ${formatDuration(remaining)}. Claim it before then.`;
                return;
            }

            clearInterval(invitationExpiryTimer);
            invitationExpiryTimer = null;
            expiry.textContent = "Reservation expired. These invitations may be given to someone else.";
            expiry.classList.add("expired");
            const list = $("invitationList");
            list.classList.add("expired");
            for (const link of list.querySelectorAll("a")) {
                link.setAttribute("aria-disabled", "true");
                link.removeAttribute("href");
            }
            for (const qr of list.querySelectorAll(".invitation-qr")) qr.hidden = true;
            for (const button of list.querySelectorAll("button")) {
                button.disabled = true;
            }
        }

        /** One QR card per voucher; a single voucher gets the whole width. */
        function renderInvitationList(entries) {
            const list = $("invitationList");
            list.replaceChildren();
            list.classList.remove("expired");
            list.style.gridTemplateColumns = entries.length === 1 ? "1fr" : "";
            entries.forEach((entry, index) => {
                const item = document.createElement("article");
                item.className = "invitation-item dh-card";

                if (entries.length > 1) {
                    const title = document.createElement("h3");
                    title.textContent = `Invitation ${index + 1} of ${entries.length}`;
                    item.appendChild(title);
                }

                const figure = document.createElement("figure");
                figure.className = "invitation-qr";
                const img = document.createElement("img");
                img.alt = "Scan invitation with Dash Wallet";
                const svg = renderSVG(entry.invitation, { border: 4, ecc: "M" });
                img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
                const caption = document.createElement("figcaption");
                caption.textContent = "Scan with Dash Wallet";
                figure.append(img, caption);
                item.appendChild(figure);

                const actions = document.createElement("div");
                actions.className = "action-buttons";
                const open = document.createElement("a");
                open.className = "dh-btn";
                open.href = entry.invitation;
                open.textContent = "Open in Dash Wallet";
                const copy = document.createElement("button");
                copy.className = "dh-btn";
                copy.textContent = "Copy";
                copy.addEventListener("click", () => copyText(entry.invitation, copy));
                actions.append(open, copy);
                item.appendChild(actions);

                list.appendChild(item);
            });
        }

        function resetInvitationCard() {
            const card = $("invitationCard");
            card.classList.remove("show-results", "success");
            $("invitationErrorBox").classList.remove("visible");
            clearInterval(invitationExpiryTimer);
            invitationExpiryTimer = null;
            $("invitationList").replaceChildren();
        }

        /** Offer 1..max vouchers per request; hidden when the server allows only one. */
        function configureInvitationCount(max) {
            const row = $("invitationCountRow");
            const select = $("invitationCount");
            const limit = Math.max(1, Number(max) || 1);
            const previous = Number(select.value) || 1;
            select.replaceChildren();
            row.hidden = limit === 1;
            if (limit === 1) return;
            for (let n = 1; n <= limit; n += 1) {
                const option = document.createElement("option");
                option.value = String(n);
                option.textContent = String(n);
                select.appendChild(option);
            }
            select.value = String(Math.min(previous, limit));
        }

        async function requestInvitation() {
            const card = $("invitationCard");
            const btn = $("invitationBtn");
            const btnText = btn.querySelector(".btn-text");
            const errorBox = $("invitationErrorBox");

            // The picker is emptied whenever it is hidden, so this reads 1 then.
            const count = Number($("invitationCount").value) || 1;

            btn.setAttribute("aria-busy", "true");
            btn.disabled = true;
            errorBox.classList.remove("visible");
            try {
                btnText.textContent = "Verifying…";
                const turnstileToken = await solveTurnstile("invitation");
                btnText.textContent = "Creating…";
                const response = await fetch("/api/invitation-faucet", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ turnstileToken, count }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    let message = data.error || data.detail?.error || "Invitation request failed";
                    const retryAfter = data.retryAfter ?? data.detail?.retryAfter;
                    if (response.status === 429 && retryAfter) {
                        message += ` — try again in ${formatDuration(retryAfter)}.`;
                    }
                    throw new Error(message);
                }

                // Servers predating batch issuance return only the single fields.
                const entries = Array.isArray(data.invitations) && data.invitations.length
                    ? data.invitations
                    : [{ invitation: data.invitation, txid: data.txid, expiresAt: data.expiresAt }];
                renderInvitationList(entries);
                const n = entries.length;
                const shortfall = data.requested > n
                    ? ` Only ${n} of ${data.requested} requested were available.`
                    : "";
                $("invitationResultTitle").textContent =
                    n === 1 ? "Invitation ready" : `${n} invitations ready`;
                $("invitationResultHint").textContent = n === 1
                    ? `Open this in Dash Wallet, then choose your username.${shortfall}`
                    : `Each QR code is a separate invitation. Give one to each person; each is claimed once.${shortfall}`;
                card.classList.add("show-results", "success");
                clearInterval(invitationExpiryTimer);
                $("invitationExpiry").classList.remove("expired");
                updateInvitationCountdown(data.expiresAt);
                if (data.expiresAt > Date.now()) {
                    invitationExpiryTimer = setInterval(
                        () => updateInvitationCountdown(data.expiresAt),
                        1000
                    );
                }
            } catch (error) {
                errorBox.textContent = error.message;
                errorBox.classList.add("visible");
            } finally {
                clearTurnstile("invitation");
                btn.removeAttribute("aria-busy");
                btn.disabled = false;
                btnText.textContent = "Get invitation";
            }
        }

        /**
         * Send one faucet request.
         *
         * Try Turnstile first, then soft PoW on testnet if it fails. A rate-limit
         * response can offer the hard tier after either initial proof.
         */
        async function requestCoreFaucet(proof, proofTier) {
            const card = $("coreFaucetCard");
            const btn = $("coreFaucetBtn");
            const addressInput = $("addressInput");
            const btnText = btn.querySelector(".btn-text");

            // A hard solve is minutes of work the user has already started; a
            // stray click or Enter must not discard it and fall back to a fresh
            // Turnstile attempt. The widget's own solve callback is exempt.
            if (coreRequestPending || (capSolving && !proof)) return;
            if (proof && !pendingRequest) return;

            if (!proof) {
                if (!statusReady) {
                    await (statusFailed ? loadStatus() : statusPromise);
                    if (!statusReady) {
                        showError("Faucet availability is unknown. Retry faucet status before requesting funds.");
                        return;
                    }
                }
                addressTouched = true;
                if (!await validateAddressInput()) {
                    addressInput.focus();
                    return;
                }
                const submitted = [addressInput.value, $("amountInput").value, $("codeInput").value].join("\n");
                await sessionPromise;
                if (coreRequestPending || capSolving) return;
                if ([addressInput.value, $("amountInput").value, $("codeInput").value].join("\n") !== submitted) return;
            }
            const { address, amount, code } = proof ? pendingRequest : {
                address: addressInput.value.trim(),
                amount: requestedAmount(),
                code: $("codeInput").value.trim(),
            };
            if (Number.isNaN(amount)) {
                showError("Enter an amount of at least 0.001, with at most 8 decimal places");
                $("amountInput").focus();
                return;
            }
            if (!proof) pendingRequest = { address, amount, code };
            if (!session && !code && amount !== null && amountLimits && amount > amountLimits.publicMax) {
                showSignIn(true);
                showError(`Amounts above ${formatAmount(amountLimits.publicMax)} ${coinName} need a dash.org sign-in or a code.`);
                return;
            }
            // Large amounts take Turnstile or nothing: the server refuses proof
            // of work for them, so falling back to it would only waste a solve.
            // A code goes through the captcha path even when signed in.
            const useSession = !!session && !code;
            const strict = !useSession && (needTurnstile ||
                (amount !== null && !!amountLimits && amount > amountLimits.turnstileAbove));

            btn.setAttribute("aria-busy", "true");
            btn.disabled = true;
            coreRequestPending = true;
            $("coreErrorBox").classList.remove("visible");
            $("bridgeReturn").hidden = true;
            const returnsToBridge = Boolean(returnUrl) && address === entryParams.get("address");

            try {
                let body;
                const headers = { "Content-Type": "application/json" };
                if (proof) {
                    body = { address, ...proof };
                } else if (useSession) {
                    // Signed in: the session pays, no captcha. The CSRF token
                    // is what tells the server to use the cookie at all.
                    body = { address };
                    headers["X-CSRF-Token"] = session.csrf;
                } else {
                    disposeCapWidget();
                    hideHardCaptcha();
                    btnText.textContent = "Verifying…";
                    body = { address };
                    try {
                        const turnstileToken = await solveTurnstile("core", strict);
                        assertUnchanged();
                        if (turnstileToken) body.turnstileToken = turnstileToken;
                        else if (capEndpoint) throw new Error("Using proof of work");
                    } catch (error) {
                        if (strict) {
                            throw new Error(`${error.message}. Amounts above ${amountLimits ? formatAmount(amountLimits.turnstileAbove) : "this"} ${coinName} need this check; try again or ask for less.`);
                        }
                        if (!capEndpoint) throw error;
                        clearTurnstile("core");
                        assertUnchanged();
                        await showPowCaptcha("soft", true);
                        return;
                    }
                }

                if (amount !== null) body.amount = amount;
                if (code) body.code = code;
                btnText.textContent = "Sending…";
                const response = await fetch("/api/core-faucet", {
                    method: "POST",
                    headers,
                    credentials: "same-origin",
                    body: JSON.stringify(body),
                });
                const data = await response.json().catch(() => ({}));

                // Whatever the outcome, the token this attempt carried is spent.
                if (proof) disposeCapWidget();

                if (!response.ok) {
                    if (data.requiresTurnstile) {
                        // Only reachable when a proof of work stood in for
                        // Turnstile, e.g. a code worth more than the threshold.
                        needTurnstile = true;
                        hideHardCaptcha();
                        throw new Error("This amount needs the full captcha check, not proof of work. Press the button again to try it.");
                    }
                    if (data.requiresSignIn) {
                        if (session) await loadSession();
                        showSignIn(!session);
                    }
                    if (!proof && !strict && capEndpoint && data.requiresProofOfWork) {
                        clearTurnstile("core");
                        assertUnchanged();
                        await showPowCaptcha("soft", true);
                        return;
                    }
                    // The server sets requiresHardCaptcha only when a stronger
                    // proof would actually raise this client's own ceiling — not,
                    // for instance, when the global daily budget is what ran out.
                    // A hard solve must not loop back into another escalation.
                    const escalate =
                        response.status === 429 &&
                        proofTier !== "hard" &&
                        hardCapEndpoint &&
                        (data.requiresHardCaptcha || data.detail?.requiresHardCaptcha);
                    if (escalate) {
                        assertUnchanged();
                        await showPowCaptcha();
                        return;
                    }

                    let message = data.error || data.detail?.error || "Request failed";
                    if (data.detailMessage && response.status < 500) message += ` (${data.detailMessage})`;
                    const retryAfter = data.retryAfter ?? data.detail?.retryAfter;
                    if (response.status === 429 && retryAfter) {
                        message += ` — try again in ${formatDuration(retryAfter)}.`;
                    }
                    throw new Error(message);
                }

                // The server is idempotent per (address, UTC day): asking twice
                // returns the first transaction rather than paying again. That
                // is a 200 in which no money moved, so reporting it as "Sent!"
                // would be a lie the user can only catch by watching a balance
                // that never changes.
                if (data.replay) {
                    $("bridgeReturn").hidden = !returnsToBridge;
                    throw new Error(
                        `That address already received ${data.amount} ${coinName} today ` +
                            `(tx ${data.txid.slice(0, 12)}\u2026). Use a different address, ` +
                            `or try again after 00:00 UTC.`
                    );
                }

                hideHardCaptcha();
                showSignIn(false);
                needTurnstile = false;
                $("coreSentAmount").textContent = `${data.amount} ${coinName} to ${data.address ?? address}`;
                const tx = document.createElement("dashhq-hash");
                tx.setAttribute("value", data.txid);
                tx.textContent = data.txid;
                tx.setAttribute("href", `${faucetNetwork === "testnet" ? "https://insight.testnet.networks.dash.org" : "https://insight.dash.org"}/insight/tx/${encodeURIComponent(data.txid)}`);
                $("coreTxid").replaceChildren(tx);
                card.classList.remove("show-config");
                card.classList.add("show-results", "success");
                addressInput.value = "";
                $("codeInput").value = "";
                $("amountInput").value = "";
                updateAmountHint();
                pendingRequest = null;
                $("bridgeReturn").hidden = !returnsToBridge;
                $("sentHeading").scrollIntoView({ block: "center" });
            } catch (error) {
                showError(error.message);
                // An escalated attempt that failed leaves the box open but
                // empty, so offer a fresh challenge rather than a dead panel.
                // Dispose again here: a request that threw before reaching the
                // response never got to burn its widget above.
                if (proof && !needTurnstile && pendingRequest) {
                    disposeCapWidget();
                    await showPowCaptcha(proofTier).catch((err) => showError(err.message));
                }
            } finally {
                clearTurnstile("core");
                coreRequestPending = false;
                btn.removeAttribute("aria-busy");
                void validateAddressInput();
                updateSendLabel();
            }
        }

        function formatDuration(seconds) {
            if (seconds < 60) return `${seconds}s`;
            const minutes = Math.ceil(seconds / 60);
            if (minutes < 60) return `${minutes} min`;
            return `${Math.ceil(minutes / 60)}h`;
        }

        function metaItems(parts) {
            return parts.map(text => {
                const item = document.createElement("span");
                item.textContent = text;
                return item;
            });
        }

        function formatBalance(value) {
            if (value == null || value === "") return "Unavailable";
            const amount = Number(value);
            if (!Number.isFinite(amount)) return "Unavailable";
            return amount.toLocaleString(undefined, {
                minimumFractionDigits: 4,
                maximumFractionDigits: 8,
            });
        }

        function invitationAvailability(data) {
            const inventory = data.invitationInventory || {};
            const available = Number(inventory.available) || 0;
            const preparing = Number(inventory.preparing) || 0;
            if (data.invitationError) return "Invitation treasury unavailable";
            if (available > 0) return `${available.toLocaleString()} invitation${available === 1 ? "" : "s"} ready now`;
            if (preparing > 0) return `${preparing.toLocaleString()} invitation${preparing === 1 ? "" : "s"} preparing`;
            return Number(data.invitationBalance) > 0 ? "Inventory is refilling" : "Inventory empty · funding required";
        }

        /** Ready stock first, then what is still locked in preparing or reserved invitations. */
        function invitationStock(data) {
            const availability = invitationAvailability(data);
            if (data.invitationError) return availability;
            const inventory = data.invitationInventory || {};
            const preparing = Number(inventory.preparing) || 0;
            const reserved = Number(inventory.issued) || 0;
            const parts = [availability];
            if (!/preparing$/.test(availability)) parts.push(`${preparing.toLocaleString()} preparing`);
            parts.push(`${reserved.toLocaleString()} reserved`);
            return parts.join(" · ");
        }

        function networkPresentation(network) {
            return network === "mainnet"
                ? {
                    badge: "Mainnet · real DASH",
                    currency: "DASH",
                    warning: "real mainnet DASH only",
                }
                : {
                    badge: "Testnet",
                    currency: "tDASH",
                    warning: "testnet DASH only",
                };
        }

        function applyNetworkPresentation(prefix, network) {
            const presentation = networkPresentation(network);
            const kicker = $(`${prefix}NetworkKicker`);
            const badge = $(`${prefix}NetworkBadge`);
            $(`${prefix}NetworkLabel`).textContent = presentation.badge;
            kicker.classList.toggle("mainnet", network === "mainnet");
            badge.textContent = presentation.badge;
            badge.classList.toggle("mainnet", network === "mainnet");
            $(`${prefix}TreasuryCurrency`).textContent = presentation.currency;
            $(`${prefix}NetworkWarning`).textContent = presentation.warning;
            return presentation;
        }

        function copyFrom(targetId, btn) {
            return copyText($(targetId).textContent, btn);
        }

        async function copyText(text, btn) {
            const original = btn.textContent;
            try {
                await navigator.clipboard.writeText(text);
                btn.textContent = "Copied";
                btn.classList.add("copied");
                setTimeout(() => {
                    btn.textContent = original;
                    btn.classList.remove("copied");
                }, 2000);
            } catch {
                const target = btn.closest("dd, .funding-address")?.querySelector("dashhq-hash");
                if (target) {
                    const range = document.createRange();
                    range.selectNodeContents(target);
                    const sel = getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
                btn.textContent = "Select and copy";
                setTimeout(() => { btn.textContent = original; }, 2000);
            }
        }

        /** An edit changes the payout, so a check started for the old one stops. */
        function cancelPendingProof() {
            if (!pendingRequest) return;
            pendingRequest = null;
            if (!capWidget) return;
            disposeCapWidget();
            hideHardCaptcha();
            void validateAddressInput();
        }

        function assertUnchanged() {
            if (!pendingRequest) throw new Error("The request changed while it was being checked. Press the button again to send it.");
        }

        function showCoreFaucetConfig() {
            $("coreFaucetCard").classList.add("show-config");
            void validateAddressInput();
        }

        function resetCoreFaucetCard() {
            const card = $("coreFaucetCard");
            card.classList.remove("show-results", "success");
            card.classList.add("show-config");
            $("bridgeReturn").hidden = true;
            addressTouched = false;
            $("addressInput").value = "";
            $("coreErrorBox").classList.remove("visible");
            hideHardCaptcha();
            disposeCapWidget();
            pendingRequest = null;
            needTurnstile = false;
            updateAmountHint();
            showCoreFaucetConfig();
        }

        function applyNetworkCopy(network) {
            const copy = NETWORK_COPY[network];
            if (!copy) return;
            if (invitationPage) return;
            faucetNetwork = network;
            document.title = "Faucet · dashhq";
            $("pageTitle").textContent = network === "mainnet" ? "Get DASH" : "Get testnet DASH";
            $("pageSubtitle").textContent = network === "mainnet" ? "Mainnet · real DASH. Get DASH to fund an identity on Dash Platform."
                : "Practice funds with no monetary value.";
            $("addressHint").textContent = network === "testnet" ? "A testnet address starts with y." : "A mainnet address starts with X.";
            $("configHeading").textContent = "Request funds";
            $("sentHeading").textContent = copy.sent;
            $("addressInput").placeholder = copy.placeholder;
            coinName = copy.coin;
            updateSendLabel();
            if (network === "mainnet") $("addressIntro").hidden = true;
            const bar = document.querySelector("dashhq-bar");
            bar.setAttribute("network", network);
            bar.setAttribute("aria-description", `This faucet serves ${network === "testnet" ? "Testnet" : "Mainnet"} only. The network cannot be changed here.`);
            void validateAddressInput();
            for (const el of document.querySelectorAll(".coin-name")) {
                el.textContent = copy.coin;
            }
        }

        function statusTime(date) {
            return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date) + " UTC";
        }

        setInterval(() => {
            if (!lastStatusSuccess || statusFailed) return;
            const minutes = Math.floor((Date.now() - lastStatusSuccess.getTime()) / 60000);
            $("statusSource").textContent = minutes < 1 ? "Just now" : `${minutes} min ago`;
        }, 30000);

        function loadStatus() {
            statusPromise = readStatus();
            return statusPromise;
        }

        async function readStatus() {
            try {
                $("retryStatusBtn").hidden = true;
                if (!invitationPage) {
                    statusReady = false;
                    statusFailed = false;
                    void validateAddressInput();
                }
                $("statusBar").textContent = "Checking faucet availability…";
                const response = await fetch("/api/status", { signal: AbortSignal.timeout(12000) });
                const data = await response.json();
                if (!response.ok && !(response.status === 503 && data.status === "low_balance")) throw new Error("Status check failed");

                if (data.status !== "ok" && data.status !== "low_balance") {
                    throw new Error("Faucet unavailable");
                }
                if (!invitationPage && (!["testnet", "mainnet"].includes(data.network) || !Number.isFinite(Number(data.coreFaucetAmount)) || Number(data.coreFaucetAmount) <= 0)) throw new Error("Invalid faucet configuration");
                lastStatusSuccess = new Date();
                $("statusSource").textContent = "Just now";
                $("statusSource").dateTime = lastStatusSuccess.toISOString();
                $("statusSource").title = statusTime(lastStatusSuccess);

                if (!invitationPage) {
                    applyNetworkCopy(data.network);
                    statusReady = true;
                    defaultAmount = Number(data.coreFaucetAmount);
                    void validateAddressInput();

                    const balance = parseFloat(data.balance);
                    // Quote the default tier; fallback PoW uses the soft allowance.
                    const limit = data.rateLimits?.turnstile ?? data.rateLimitPerHour;
                    const networkName = data.network === "mainnet" ? "Mainnet" : "Testnet";
                    const parts = [
                        data.status === "low_balance" ? `${networkName} faucet low balance` : "Faucet online",
                        `Core rate limit: ${limit}/hour`,
                        `${networkName} block: ${Number(data.blockHeight).toLocaleString()}`,
                    ];
                    $("statusBar").replaceChildren(...metaItems(parts));

                    if (data.depositAddress) {
                        $("depositAddress").textContent = data.depositAddress;
                        $("depositAddress").setAttribute("value", data.depositAddress);
                    }
                    $("coreFunding").hidden = !data.depositAddress;
                    $("coreFundingCopy").disabled = !data.depositAddress;
                    amountLimits = data.amountLimits || null;
                    const publicMax = amountLimits?.publicMax;
                    const choosesAmount = publicMax > data.coreFaucetAmount;
                    $("amountInput").placeholder = String(data.coreFaucetAmount);
                    // Where a captcha buys only the standard payout and nobody can
                    // sign in (mainnet), there is nothing to choose.
                    canSignIn = !!data.accountUrl;
                    const showAmount = canSignIn || choosesAmount;
                    $("amountRow").hidden = !showAmount;
                    // A `?amount=` link must not send a value nobody can see.
                    if (!showAmount) $("amountInput").value = "";
                    sessionPromise = data.accountUrl ? loadSession() : null;
                    if (!sessionPromise) updateAmountHint();
                    const corePresentation = networkPresentation(data.network);
                    $("coreNetworkWarning").textContent = corePresentation.warning;
                    $("coreReserveLabel").textContent = `${networkName} faucet`;
                    $("coreReserveBalance").textContent = Number.isFinite(balance)
                        ? `≈ ${balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Unavailable";
                    $("coreReserveNote").textContent = choosesAmount
                        ? `Up to ${formatAmount(publicMax)} ${corePresentation.currency} per request`
                        : `${formatAmount(Number(data.coreFaucetAmount))} ${corePresentation.currency} per request`;
                    $("coreReserveCurrency").textContent = corePresentation.currency;
                    const coreCoverage = reserveCoverage(balance, data.dailyBudgetSats, corePresentation.currency);
                    $("coreReserve").dataset.state = coreCoverage.state;
                    $("coreReserveCoverage").textContent = coreCoverage.label;
                    $("invitationReserve").hidden = !data.invitationsEnabled;
                    if (data.invitationsEnabled) {
                        const invitationNetwork = data.invitationNetwork || data.network;
                        const presentation = networkPresentation(invitationNetwork);
                        $("invitationReserveLabel").textContent = `${invitationNetwork === "mainnet" ? "Mainnet" : "Testnet"} invitations`;
                        $("invitationReserveBalance").textContent = data.invitationError ? "Unavailable" : formatBalance(data.invitationBalance);
                        $("invitationReserveCurrency").textContent = presentation.currency;
                        $("invitationReserve").dataset.state = data.invitationError ? "unknown"
                            : Number(data.invitationInventory?.available) > 0 ? "good" : "warn";
                        $("invitationReserveCoverage").textContent = invitationStock(data);
                        $("invitationEntryAmount").textContent = data.invitationAmount ?? "Unavailable";
                        $("invitationEntryCurrency").textContent = presentation.currency;
                        const kicker = $("invitationEntry").querySelector(".network-kicker");
                        kicker.textContent = presentation.badge;
                        kicker.classList.toggle("mainnet", invitationNetwork === "mainnet");
                    }
                    const invitationAddress = typeof data.invitationDepositAddress === "string" ? data.invitationDepositAddress.trim() : "";
                    $("invitationHomeTreasuryCard").hidden = !invitationAddress;
                    $("invitationDepositAddress").textContent = invitationAddress || "—";
                    $("invitationDepositAddress").setAttribute("value", invitationAddress || "—");
                    $("invitationFundingCopy").disabled = !invitationAddress;
                    $("invitationNetworkWarning").textContent = networkPresentation(data.invitationNetwork || data.network).warning;
                    $("reserveStatus").textContent = "Live";
                    $("reserveSummary").hidden = false;
                }
                if (data.turnstileSiteKey) {
                    turnstileSiteKey = data.turnstileSiteKey;
                }
                if (data.hardCapEndpoint) {
                    hardCapEndpoint = data.hardCapEndpoint;
                }
                capEndpoint = data.network === "testnet" ? data.capEndpoint || "" : "";
                $("networkChoice").hidden = Boolean(returnUrl) || (!invitationPage && !data.invitationsEnabled);
                if (!invitationPage) {
                    $("invitationEntry").hidden = Boolean(returnUrl) || !data.invitationsEnabled;
                    $("invitationEntryAvailability").textContent = invitationAvailability(data);
                    $("devEntry").hidden = Boolean(returnUrl) || !data.apiKeysEnabled || !data.accountUrl;
                }
                if (data.invitationsEnabled && invitationPage) {
                    $("statusBar").textContent = "Mainnet invitations";
                    $("invitationCard").hidden = false;
                    $("featureGrid").classList.add("has-invitations");
                    $("invitationAmountDisplay").textContent = data.invitationAmount;
                    configureInvitationCount(data.invitationMaxPerRequest);

                    const invitationNetwork = data.invitationNetwork || data.network;
                    const inventory = data.invitationInventory || {};
                    const available = Number(inventory.available) || 0;
                    const preparing = Number(inventory.preparing) || 0;
                    const issued = Number(inventory.issued) || 0;
                    applyNetworkPresentation("invitation", invitationNetwork);
                    $("invitationTreasuryCard").hidden = false;
                    $("treasuryPanel").hidden = false;
                    document.querySelector("dashhq-bar").setAttribute("network", invitationNetwork);
                    $("invitationTreasuryBalance").textContent =
                        formatBalance(data.invitationBalance);
                    $("invitationDepositAddress").textContent =
                        data.invitationDepositAddress || "Unavailable";
                    $("invitationDepositAddress").setAttribute("value", data.invitationDepositAddress || "Unavailable");
                    $("invitationFundingCopy").disabled = !data.invitationDepositAddress;
                    $("invitationAvailable").textContent = available.toLocaleString();
                    $("invitationPreparing").textContent = preparing.toLocaleString();
                    $("invitationIssued").textContent = issued.toLocaleString();

                    $("invitationAvailability").textContent = invitationAvailability(data);


                } else if (invitationPage) {
                    $("statusBar").textContent = "Mainnet invitations are unavailable right now. You can practice on Testnet instead.";
                }
            } catch (err) {
                statusReady = false;
                statusFailed = true;
                $("statusSource").textContent = lastStatusSuccess ? "Refresh failed. Last read: " + statusTime(lastStatusSuccess) + "." : "No status read available";
                if (!invitationPage) void validateAddressInput();
                if (!invitationPage) $("invitationEntryAvailability").textContent = "Invitation availability unknown: the status check failed.";
                if (!invitationPage) {
                    $("reserveStatus").textContent = "Last known balances · status unavailable";
                    for (const prefix of ["core", "invitation"]) {
                        $(`${prefix}Reserve`).dataset.state = "unknown";
                        $(`${prefix}ReserveCoverage`).textContent = "Last known balance · refresh failed";
                    }
                }
                $("statusBar").textContent = "Availability unknown: the status check failed at " + statusTime(new Date()) + ". This does not confirm the faucet is down. " + (lastStatusSuccess ? "Last successful check: " + statusTime(lastStatusSuccess) + ". " : "No successful check in this tab. ") + (invitationPage ? "Retry to check again." : "Your address is unchanged. Retry to check before requesting funds.");
                $("retryStatusBtn").hidden = false;
            }
        }

        $("retryStatusBtn").addEventListener("click", () => { void loadStatus(); });
        if (!invitationPage) {
            const receivingAddress = new URLSearchParams(location.search).get("address");
            if (receivingAddress) {
                $("addressInput").value = receivingAddress;
                showCoreFaucetConfig();
            }
            // Voucher and event links carry their code: open the form with it filled in.
            const sharedCode = new URLSearchParams(location.search).get("code");
            if (sharedCode) {
                $("codeInput").value = sharedCode.slice(0, 64);
                showCoreFaucetConfig();
            }
            const sharedAmount = Number(entryParams.get("amount"));
            if (sharedAmount > 0) {
                $("amountInput").value = String(sharedAmount);
                showCoreFaucetConfig();
            }
            for (const id of ["amountInput", "codeInput"]) {
                $(id).addEventListener("input", () => {
                    cancelPendingProof();
                    needTurnstile = false;
                    updateAmountHint();
                });
                $(id).addEventListener("keydown", (e) => {
                    if (e.key === "Enter") requestCoreFaucet();
                });
            }
            $("signInCodeBtn").addEventListener("click", () => $("codeInput").focus());
            if (returnUrl) {
                $("returnBridgeBtn").href = returnUrl;
                $("addressIntro").hidden = true;
                $("invitationEntry").hidden = true;
            }
            $("addressInput").addEventListener("blur", (event) => {
                // The button validates on click; a message shown on mousedown
                // would move the button out from under the pointer.
                if (event.relatedTarget === $("coreFaucetBtn")) return;
                addressTouched = true;
                void validateAddressInput();
            });
            $("addressInput").addEventListener("input", () => {
                cancelPendingProof();
                void validateAddressInput();
            });
            $("sendMoreBtn").addEventListener("click", resetCoreFaucetCard);
            // Wrapped, not passed directly: the click event would arrive as `proof`.
            $("coreFaucetBtn").addEventListener("click", () => requestCoreFaucet());
            $("addressInput").addEventListener("keydown", (e) => {
                if (e.key === "Enter") requestCoreFaucet();
            });
        }
        $("invitationBtn")?.addEventListener("click", requestInvitation);
        $("moreInvitationsBtn")?.addEventListener("click", resetInvitationCard);
        for (const btn of document.querySelectorAll("[data-copy]")) {
            btn.addEventListener("click", () => copyFrom(btn.dataset.copy, btn));
        }

        applyNetworkCopy("testnet");
        loadStatus();
