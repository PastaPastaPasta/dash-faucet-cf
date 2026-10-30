# Dash Faucet — serverless

A Dash faucet that runs entirely on Cloudflare Workers' free tier. It builds,
signs and broadcasts payouts itself, so there is no Dash Core node, no captcha
container, and no tunnel to keep alive. The only external dependencies are
public block explorers, and it fails over between several of them.

It can also run an optional identity-invitation faucet. That path pre-creates
ChainLocked 0.03 DASH asset locks and gives a wallet everything it needs to
claim one Platform identity and non-contested DPNS name.

This replaces the FastAPI + `dashd` + CAP + `cloudflared` stack in
[`PastaPastaPasta/dash-faucet`](https://github.com/PastaPastaPasta/dash-faucet).

## How it works

```
Browser ──► Worker (src/index.ts)   ◄── native clients (cap.js proof of work)
              │  Turnstile · address validation · edge rate limit
              ▼
            Treasury Durable Object (SQLite)
              │  durable limits · idempotency · in-flight coin tracking
              │  build → sign → broadcast
              ▼
            Chain layer (src/chain/) ──► hyphen  ┐
                                      ──► insight ├─ ordered failover
                                      ──► dashrpc ┤
                                      ──► DAPI    ┘  (evonodes by IP: tip + relay + lookups)
              │
              └──► Platform Explorer (identity claim checks)
```

Transactions are built and signed in the Worker with
[`dashtx`](https://www.npmjs.com/package/dashtx),
[`dashkeys`](https://www.npmjs.com/package/dashkeys) and
[`@dashincubator/secp256k1`](https://www.npmjs.com/package/@dashincubator/secp256k1)
— three zero-dependency libraries that run unmodified on `workerd`, plus
[`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes) for the
synchronous SHA-256/HMAC the proof-of-work captcha needs. The whole Worker is
~52 KiB gzipped, against a 3 MiB free-plan limit.

### Why a Durable Object

Durable Objects are single-threaded, which is what makes concurrent payouts
safe: without serialisation, two simultaneous requests read the same UTXO set
and build conflicting transactions. The DO also holds rate limits that survive
restarts — the old faucet kept them in a process-local dict that reset on every
deploy. It is Cloudflare-managed and free, so it is not infrastructure you
operate.

### Chain providers

| Provider | Mainnet | Testnet | Reads | Broadcast |
|---|---|---|---|---|
| Hyphen | `hyphen.dash.org` | — | ✓ | ✗ read-only |
| Insight | `insight.dash.org` | `insight.testnet.networks.dash.org` | ✓ | ✓ |
| Dash JSON-RPC | `rpc.digitalcash.dev` | — | ✓ | ✓ |
| DAPI (grpc-web) | 3 sampled evonodes, `:443` | 3 sampled evonodes, `:1443`; `seed-{1,2,3}` only as fallback | ✗ no address index | ✓ |

Testnet dropped `trpc.digitalcash.dev`: it stayed on Core v22 and has sat on a
dead fork at height 1,577,999 since V24 activated at 1,578,000. A forked node
still answers every call, so it looked healthy while it refused every payout.

DAPI goes straight to the evonodes. Workers' `fetch` refuses a bare IP
(Cloudflare error 1003) and evonodes are only addressable by IP, but
`cloudflare:sockets` may connect to an IP, and evonode certificates carry the IP
as a SAN, so a TLS socket verifies normally. `src/chain/socket.ts` sends each
grpc-web call as one HTTP/1.1 request over such a socket (ported from
dash-platform-workers, which runs rs-sdk the same way).

Which evonodes: `src/chain/evonodes.ts` reads the quorum service's
`/masternodes` (enabled, version-checked, `platform_https`), falls back to
Platform Explorer's active validators, and failing both uses a snapshot compiled
into the Worker. The list is refreshed hourly per isolate. Each operation asks 3
evonodes drawn at random, and one that fails is benched for 10 minutes. The DCG
`seed-N` gateways are asked only when none of the sampled evonodes answered (or,
for a broadcast, none accepted), so the faucet does not depend on them.
Discovery never blocks a request: a cold isolate serves the snapshot while the
lists refresh in the background, and a source listing fewer than 10 usable
nodes is ignored.

Evonodes are arbitrary third parties, so none of them is ever the authority for
a decision about money:

- **Tip:** the sample casts one vote, its median, next to each configured
  provider; a node far above the median is benched. One node reporting a wild
  height cannot make insight look stale.
- **Broadcast:** evonode acceptance counts only alongside a configured relay's;
  on its own it is *ambiguous*, which locks the inputs rather than reporting a
  payout. A node answering with a different txid is benched.
- **`hasTx`:** an evonode's "yes" never settles an ambiguous broadcast as live;
  its "no" can only keep inputs locked.
- **ChainLock status** (which makes invitation vouchers usable, or failed) comes
  from configured providers only. Coinbase lookups try them first.
- Every socket exchange — connect included — is raced against the call's
  deadline: a black-holed address costs 2.5 s, not the OS connect timeout.

DAPI has no address or UTXO lookup, so insight remains the sole testnet UTXO
source; DAPI serves as relays, `hasTx`/coinbase/ChainLock lookups, and an
independent tip that insight's lag check is measured against. Mainnet gets the
same evonode relays, so it no longer rests on a single Core RPC endpoint.

Reads take the first healthy provider that is not lagging the best-known tip;
refusing a stale provider is what stops the faucet spending coins the rest of
the network already knows are gone. Broadcasts are fanned out to every
relay-capable provider at once, which removes the single point of failure and
improves propagation. "Already in mempool" counts as success, not failure.

Height checks and lookups get 2.5 s each. A UTXO listing gets 8 s and one retry
on the preferred provider: its size grows with the coin count (~240 KB for the
testnet faucet's ~870 coins), and under the shared 2.5 s budget insight's slow
tail turned into intermittent "Chain providers unavailable" errors.

### The UTXO pool

Coins under 101 blocks deep are classified before use, because testnet miners
pay block rewards straight to the faucet address, and Core refuses to spend a
coinbase output until it is 100 blocks deep. Each young transaction is looked up
once (at most six per view) and the verdict cached in `coinbase_checks`. Young
rewards, and young coins nobody could classify, are left out of the spendable
view, so they also do not count towards `/api/status`'s balance until they mature.

A cron trigger keeps the faucet's balance split into several equal coins. Dash's
mempool allows a chain of at most 25 unconfirmed ancestors, so a single chain of
change outputs would stall after 25 payouts until a block lands. N independent
pool coins give 25 × N in-flight payouts per block instead.

## API

Response shapes match the old Python faucet, so existing clients and the
`dash-faucet` skill keep working.

### `GET /api/status`

```json
{
  "status": "ok",
  "balance": 94.87,
  "coreFaucetAmount": 1.0,
  "rateLimitPerHour": 3,
  "depositAddress": "y...",
  "blockHeight": 1540992,
  "availableUtxos": 12,
  "network": "testnet",
  "turnstileSiteKey": "0x...",
  "capEndpoint": "https://faucet.example/cap/v1/",
  "hardCapEndpoint": "https://faucet.example/cap/hard/",
  "rateLimits": { "soft": 3, "turnstile": 10, "hard": 25 },
  "providers": [{ "name": "insight", "ok": true, "height": 1540992, "error": null }]
}
```

Returns `503` with `status: "low_balance"` when the balance is under
`MIN_BALANCE_SATS`.

### `POST /api/core-faucet`

```bash
curl -X POST https://faucet.example/api/core-faucet \
  -H 'content-type: application/json' \
  -d '{"address":"y...","turnstileToken":"..."}'
```

```json
{ "txid": "...", "amount": 1.0, "address": "y...", "network": "testnet", "replay": false }
```

Errors carry both a flat shape and FastAPI's nested `detail`, so old and new
clients both work:

```json
{ "error": "Rate limit exceeded", "retryAfter": 1800, "requiresHardCaptcha": true,
  "detail": { "error": "Rate limit exceeded", "retryAfter": 1800,
              "requiresHardCaptcha": true } }
```

Send `turnstileToken` or a solved proof-of-work `capToken`.
The testnet browser automatically falls back to the short PoW challenge if
Turnstile cannot load, fails, requires interaction, or stalls for eight seconds.
Testnet CAPTCHA rejections include `requiresProofOfWork: true`, so the browser
also falls back when server-side Turnstile verification fails. A valid PoW is
still required, and uses the soft-tier rate limit. Mainnet invitations continue
to require Turnstile.
They are separate credentials verified by separate code paths; a `capToken` is
never forwarded to Turnstile. `hardCapToken` is accepted as an alias for
`capToken`, for old web clients — it is only a field name and claims nothing
about strength.

`requiresHardCaptcha` appears on a `429` from the per-IP limit when, and only
when, re-solving at the hard tier would raise this client's own ceiling. It is
absent when the daily budget is what ran out, since no proof of work moves that.

`400` invalid address or captcha · `429` rate limited or daily budget spent
(`Retry-After` set) · `503` insufficient funds or every explorer unreachable.

Requesting the same address twice in one UTC day returns the original `txid`
with `replay: true` rather than paying again.

### API keys

`Authorization: Bearer dfk_…` on `POST /api/core-faucet` replaces the captcha
(testnet only). Key payouts skip the edge limit, the per-IP limit, the
per-address daily replay and the public daily budget; none of them count
against the public faucet either.

```bash
curl -X POST https://faucet.thepasta.org/api/core-faucet \
  -H "Authorization: Bearer $DASH_FAUCET_KEY" \
  -H 'content-type: application/json' \
  -d '{"address":"y...","amount":250}'
```

| Tier | Pays | Limit |
|---|---|---|
| `trusted` | `amount` in DASH (default `PAYOUT_SATS`), up to `KEY_MAX_PER_REQUEST_SATS` | none by default |
| `mn` | exactly 1000 DASH in one output — a masternode collateral; `amount` must be omitted | 1 per rolling 24 h by default |

What still applies to every key: a payout may never leave the wallet below
`KEY_RESERVE_SATS` (before the fee).

A payout one coin cannot cover is built from up to `MAX_PAYOUT_INPUTS` (500)
of the largest *confirmed* coins, so a large amount needs no big coin. CPU
does not limit this: signing runs in the Treasury Durable Object, which gets
30 s of CPU per invocation even on the free plan. Measured on the edge, it
costs ~0.3 ms per input (1000 inputs in ~250 ms). Relay policy is the limit
instead: Core refuses transactions over 100 kB (~650 inputs), and any
unconfirmed chain over 25 transactions or 101 kB. That is also why only one
unconfirmed coin may ever go into a transaction, and only on its own.

When the confirmed coins cannot cover an amount, the payout answers `503`
with `Retry-After` (60 s) and starts merging at once. That happens when the
amount needs coins still confirming, or more than `MAX_PAYOUT_INPUTS` of
them. In that second case, maintenance merges toward a coin that pays the
amount by itself (plus 1 DASH of headroom) for the next hour, so the retry
is a single input. It spends the kept collateral coin on that only when
nothing else reaches the amount. An amount no merge can reach gets its `503`
without `Retry-After`, and never holds up a collateral coin.

For `mn` keys the Treasury keeps `COLLATERAL_COINS` coins of at least 1001
DASH on hand, so an `mn` payout is normally one input. Merging runs as soon
as one is missing, not on the next cron:
- Spending a collateral coin, any key payout, and any `503` above each book a
  Durable Object alarm a couple of seconds out.
- Maintenance books itself again while there is work left: seconds after a
  merge or split, and every minute while the coins a merge needs are still
  confirming.
- The 10-minute cron runs the same maintenance as a backstop. It is what
  notices deposits.

A merge spends confirmed coins only. It reaches 1001 DASH with the fewest
large coins it can, and fills the rest of its `MAX_PAYOUT_INPUTS` with the
smallest, since those are the coins nothing else can spend. The smallest
`POOL_TARGET` pool coins stay untouched. When even `MAX_PAYOUT_INPUTS` coins
fall short, it merges the largest and finishes the job a block later. Pool
refills split from the largest coin *below* collateral size. `/api/status`
reports `collateralUtxos`.

The response is the usual payout body plus `keyId`. Errors: `401` (unknown or
revoked key), `400` (bad `amount`), `429` with `Retry-After` (an `mn` key's
daily limit).

People get their own keys at **`/keys`** (see *Accounts* below); nobody has
to mint them by hand. Admins can also mint keys, including `mn` keys, at
`/admin` or with the admin token, whose SHA-256 is `ADMIN_TOKEN_SHA256`.
Only each key's SHA-256 is stored; the plaintext is shown once.

```bash
ADMIN="Authorization: Bearer $(cat ~/.config/dash-faucet/admin-token)"
# tier: trusted | mn; perDay: optional positive integer, or null for unlimited
curl -X POST https://faucet.thepasta.org/api/admin/keys -H "$ADMIN" \
  -H 'content-type: application/json' -d '{"label":"alice (DCG)","tier":"trusted"}'
curl https://faucet.thepasta.org/api/admin/keys -H "$ADMIN"          # list, with usage
curl -X DELETE https://faucet.thepasta.org/api/admin/keys/<id> -H "$ADMIN"  # revoke
```

### Accounts: `/keys` and `/admin`

Login lives on one origin, `AUTH_ORIGIN` (`https://faucet.dashhq.org`).
Session cookies are host-only, so `/keys`, `/admin` and `/auth/*` on any other
hostname redirect there.

**Who may sign in.** Anyone the provider vouches for; there is no allowlist
and no approval step.

- **Google:** a `@dash.org` Google Workspace account. The callback checks the
  ID token's RS256 signature against Google's published keys, `iss`, `aud`,
  `exp`/`iat`, the OIDC `nonce`, `email_verified`, `hd == "dash.org"` and the
  address's domain. The `hd` request parameter only pre-selects an account
  and is never relied on. A personal Google account registered with a
  dash.org address has no `hd` and is refused.
- **GitHub** (supported, but not configured in production, which uses
  Google only): an *active* member of the `dashpay` org, or an account with a
  *verified* `@dash.org` address. The GitHub token is used for those two
  reads and then revoked. Setting `OAUTH_GITHUB_CLIENT_ID`/`_SECRET` turns it
  on.

**Sessions** are HMAC-signed `__Host-` cookies (`HttpOnly; Secure;
SameSite=Lax`, 12 h), with no server-side store. The OAuth round trip is
bound by a second signed cookie holding `state`, `nonce` and the PKCE
verifier, valid for 10 minutes and spent by the callback. After login the
user only ever lands on `/keys` or `/admin`, so there is no open redirect.
Every cookie-authenticated write needs the session's CSRF token in
`X-CSRF-Token` *and* a same-origin `Origin` header. The pages are served with
a strict CSP (`script-src 'self'`, no inline script), and they render server
data as text only.

**Self-serve keys** (`/api/me/keys`) are `trusted`, tied to the signed-in
identity, and expire after `SELF_SERVE_KEY_TTL_DAYS` (180). Rotating gives a
fresh value and expiry and revokes the old key in the same step. A person can
hold `MAX_KEYS_PER_USER` (5) active keys, and can only list, rotate or revoke
their own.

**Admins** are the `AUTH_ADMINS` identities: `google:<email>` or
`github:<numeric id>`, pinned by id so a renamed account cannot inherit
access. At `/admin` they manage codes, list and revoke anyone's key, and mint
`mn` or service keys. The admin bearer token still works for every
`/api/admin/*` route.

### Codes

`POST /api/core-faucet` accepts `"code"` (or `"promoCode"`, the Python
faucet's name). The captcha is still required, but the code replaces the
public per-IP, per-address and daily-budget limits with its own:

- **event codes:** typeable (`DASHCON-26`), with an amount, a redemption cap
  and an optional expiry. Each address may redeem one once. There is
  deliberately no per-IP rule, since a whole venue shares one NAT address. A
  guess costs only a captcha, so anything valuable should use a code nobody
  could guess.
- **vouchers:** generated `XXXX-XXXX-XXXX` codes, single-use, created up to
  200 at a time. `/?code=…` links open the faucet with the code filled in.

Matching ignores case, spaces and dashes. Unknown, disabled, expired and
fully redeemed codes all get the same `400`, so the endpoint does not reveal
which codes exist. Redemption is decided inside the payout lock, so two
people cannot both take a code's last use. A broadcast whose outcome is
unknown still counts as a redemption. Code payouts never take the wallet
below `KEY_RESERVE_SATS`.

Admin API: `GET/POST /api/admin/codes`, then `GET/PATCH
/api/admin/codes/<id>` with any of `label, amount, maxRedemptions, expiresAt,
disabled`. `amount` is in DASH and `expiresAt` in epoch milliseconds.

### `POST /api/invitation-faucet`

Enabled only when `INVITATIONS_ENABLED=1`. It requires a Turnstile token bound
to the `invitation_faucet` action; proof-of-work tokens are not accepted. The
invitation treasury can use a different network and key from the ordinary
faucet, so the deployed service dispenses testnet DASH and real-DASH identity
invitations side by side without sharing coins or Durable Object state.

```bash
curl -X POST https://faucet.example/api/invitation-faucet \
  -H 'content-type: application/json' \
  -d '{"turnstileToken":"...","count":2}'
```

```json
{
  "invitations": [
    { "invitation": "dashpay://invite?assetlocktx=...&pk=...&islock=null", "txid": "...", "expiresAt": 1787000000000 },
    { "invitation": "dashpay://invite?assetlocktx=...&pk=...&islock=null", "txid": "...", "expiresAt": 1787000000000 }
  ],
  "count": 2,
  "requested": 2,
  "invitation": "dashpay://invite?assetlocktx=...&pk=...&islock=null",
  "txid": "...",
  "amount": 0.03,
  "expiresAt": 1787000000000,
  "replay": false,
  "network": "mainnet"
}
```

`count` is optional (default 1) and is rejected with `400` above
`INVITATION_MAX_PER_REQUEST`. One Turnstile solve covers the whole batch. When
fewer vouchers are ChainLocked than requested, the response carries what was
available and `count` < `requested`; a batch is `503` only when nothing is
ready. The top-level `invitation`/`txid`/`expiresAt` fields describe the first
entry and exist for clients written against the single-voucher response.

The Treasury builds version-3/type-8 asset-lock transactions in advance and
does not make them available until Dash Core reports that their containing
block is ChainLocked. The wallet reconstructs a `ChainAssetLockProof` from the
transaction; no InstantLock payload is required.

The web result displays the invitation as a QR code generated entirely in the
browser by the locally bundled `uqr` module. The bearer URI is not sent to an
external QR service.

This is a pure funding voucher: it does not select a username. The wallet asks
the recipient to choose a currently available, non-contested name during the
claim flow. In the legacy invitation format, the optional `du` field identifies
the inviter for contact bootstrap; using it for the recipient's desired name
would be incorrect.

With `INVITATION_RATE_WINDOW_SECS` set, each normalized IP and signed
`HttpOnly` device cookie gets one issuance (single or batch) per window. The IP
and device values are stored only as keyed HMACs. Repeating a request from the
same device during its reservation then returns the same invitations instead of
consuming more, so a lost response cannot lock the device out. With the window
at `0` there is nothing to protect and every request takes fresh vouchers,
which is what an operator onboarding a queue of people at an event needs.

An invitation is a bearer private key. The WIF is AES-GCM encrypted at rest and
is returned only in the no-store API response. After 60 minutes, maintenance
checks the prospective identity ID. A claimed invitation is retired and its
encrypted key erased; an unclaimed one goes back into inventory. This recovery
is intentionally simple and racy: after expiry, the old recipient and a new
recipient may both have the key, and whichever wallet claims the asset lock
first wins. The browser clearly marks the reservation expired at 60 minutes;
the cron may take up to its next run to recycle it.

Compatibility note: the protocol-side invitation minimum is 0.003 DASH, but
released Dash Wallets gate non-contested invitation claims at 0.03 DASH in the
username UI, so the voucher defaults to 0.03 (`INVITATION_AMOUNT_SATS`).
Inventory is tracked per amount: vouchers minted at an older amount are neither
counted nor issued, and maintenance mints replacements at the current one.
Current Android releases also structurally require a `du` field and must accept
inviter-less links before these vouchers can be claimed there.

### `POST /cap/{v1,hard}/challenge` · `POST /cap/{v1,hard}/redeem`

A [cap.js](https://capjs.js.org)-compatible proof-of-work captcha, for clients
that cannot run a browser challenge — dashwallet-ios' one-tap "get tDash" solves
this on-device via `TestnetFaucet.swift` in the Dash Platform Swift SDK.

`/cap/v1/` serves the soft shape (`CAP_*`); `/cap/hard/` serves the escalated
one (`CAP_HARD_*`) that browsers use to get past a `429`. Redeem is shared
logic — it grades against the shape the presented token itself commits to — and
the paths only stay separate because `@cap.js/widget` derives both from one
`data-cap-api-endpoint`.

```
POST /cap/v1/challenge   {}
  → { "challenge": { "c": 100, "s": 32, "d": 4 }, "token": "<50 hex>", "expires": 1758... }

client, for i in 1..c:
    salt   = prng("{token}{i}",  s)      # FNV-1a seed + xorshift32
    target = prng("{token}{i}d", d)
    nonce  = smallest n >= 0 with sha256(salt + str(n)) starting with target

POST /cap/v1/redeem      { "token": "...", "solutions": [n1..nc] }
  → { "success": true, "token": "<capToken>", "expires": 1758... }
```

`prng` is bit-identical to `@cap.js/widget`; the test vectors in
`test/cap.test.ts` come from a challenge the live cap.js server issued and then
accepted our solution for.

Both halves are stateless. The challenge token is
`hex(expiry ‖ c,s,d ‖ random ‖ HMAC(CAP_SECRET, …))`, so issuing challenges
stores nothing and cannot be exhausted — and because the challenge shape rides
inside the MAC, retuning `CAP_C`/`CAP_S`/`CAP_D` cannot reject a solve that is
already in flight. The capToken carries that token plus a second HMAC, so
`/api/core-faucet` can verify it without a lookup. The only stored
state is a self-expiring spent-set in the Durable Object that makes each
capToken usable once — burned on presentation, whether or not the payout then
succeeds.

Be clear-eyed about the strength: the Swift SDK refuses any challenge above
`c × 16^d = 64M` expected hashes, which is well under a second on a server core,
and even the hard tier's 839M is only tens of seconds for someone with real
hardware. This is friction and cost, not a bot defence. The real limits are the
per-IP rate limit and `DAILY_BUDGET_SATS`.

## Proof-strength tiers

The hourly per-IP limit scales with how strong a proof the client presented.

| Proof | Shape | Limit | Used by |
|---|---|---|---|
| soft PoW | `c=100 s=32 d=4` (6.55M) | `RATE_LIMIT_PER_HOUR` = 3 | native / iOS |
| Turnstile | — | `RATE_LIMIT_TURNSTILE_PER_HOUR` = 10 | browsers, normal path |
| hard PoW | `c=50 s=32 d=6` (839M) | `RATE_LIMIT_HARD_PER_HOUR` = 25 | browsers, after a `429` |

The hit count is per-IP and tier-blind; only the ceiling it is measured against
varies, so escalating raises the same allowance rather than opening a second
one. Every tier stays under `DAILY_BUDGET_SATS`, which remains the real limit —
`hard` is a high-but-finite ceiling rather than the old faucet's unlimited
bypass, so one IP cannot drain a day's budget in minutes.

Deriving the tier needs no new state and no new token type. `c/s/d` already live
inside the challenge token's MAC'd payload, and the capToken carries that token
as a prefix, so the faucet reads the difficulty straight off a presented token —
covered by the same signature that makes it valid at all. A soft token therefore
cannot be passed off as hard. Grading is on `c × 16^d` rather than an exact
parameter match, so retuning a tier never mis-grades a solve already in flight —
and `resolveConfig` refuses to start with a `CAP_HARD_*` shape that is not
strictly more expensive than `CAP_*`, which is the one misconfiguration that
would silently promote every native solve to the escalated allowance.

The browser side uses [`@cap.js/widget`](https://capjs.js.org) — pinned by
version and SRI, loaded when testnet Turnstile fails or after a `429`. The short
fallback starts automatically. The hard tier keeps its click-to-start UI,
since a WASM Web Worker pool chewing through 839M hashes is a minute of the
visitor's CPU. Each capToken is single-use, so one solve buys exactly one payout.
The soft fallback can still escalate to the hard tier when the server offers it.

Run `npm run test:browser` for browser CAPTCHA regression tests (install Chromium
with `npx playwright install chromium` first). These mock the CAPTCHA providers;
`npm test` covers real PoW verification, replay protection, and rate tiers.

## Configuration

Per-environment vars live in `wrangler.jsonc`; secrets are set with
`wrangler secret put`.

| Variable | Meaning |
|---|---|
| `NETWORK` | `mainnet` or `testnet` — selects address versions and providers |
| `PAYOUT_SATS` | Amount per request, in duffs |
| `RATE_LIMIT_PER_HOUR` | Durable per-IP limit for the soft proof-of-work tier (IPv6 bucketed to /48) |
| `RATE_LIMIT_TURNSTILE_PER_HOUR` | Same limit for a request backed by Turnstile |
| `RATE_LIMIT_HARD_PER_HOUR` | Same limit for a request backed by the hard proof of work |
| `DAILY_BUDGET_SATS` | Hard ceiling on total payouts per UTC day |
| `MIN_BALANCE_SATS` | Below this, status reports `low_balance` |
| `POOL_MIN` / `POOL_TARGET` / `POOL_UTXO_SATS` | Pool maintenance thresholds |
| `TURNSTILE_SITE_KEY` | Public key, served to the UI |
| `CAP_C` / `CAP_S` / `CAP_D` | Soft proof-of-work shape. Rejected at startup unless `c,s ∈ 1..256`, `d ∈ 1..6` and `c × 16^d ≤ 64M` — the bounds the Swift SDK enforces client-side |
| `CAP_HARD_C` / `CAP_HARD_S` / `CAP_HARD_D` | Escalated shape served at `/cap/hard/`. Browser-only, so the SDK's 64M bound does not apply; capped at 1B instead |
| `INVITATIONS_ENABLED` | `1` enables the identity-invitation API and UI |
| `INVITATION_NETWORK` | Optional network for invitation asset locks; defaults to `NETWORK` |
| `INVITATION_AMOUNT_SATS` | Voucher value in duffs (default 3000000 / 0.03 DASH, the floor released wallets redeem) |
| `INVITATION_INVENTORY_TARGET` | Number of ready or preparing invitations to keep on hand (default 10) |
| `INVITATION_MAX_PER_REQUEST` | Vouchers one request may take at once (default 1) |
| `INVITATION_TTL_SECS` | Recipient reservation time before recovery (default 3600) |
| `INVITATION_RATE_WINDOW_SECS` | Per-IP and per-device issuance window (default 604800 / seven days); `0` disables it |
| `INVITATION_PLATFORM_EXPLORER_URL` | Platform Explorer base URL for invitation claim checks |
| `ADMIN_TOKEN_SHA256` | SHA-256 (hex) of the admin token for `/api/admin/keys`; blank disables it |
| `KEY_MAX_PER_REQUEST_SATS` | Largest single API-key payout (default 5000 DASH) |
| `KEY_RESERVE_SATS` | API-key payouts never leave the balance below this (default 0) |
| `MAX_PAYOUT_INPUTS` | Coins one payout or merge may spend (default 500, at most 600: Core's 100 kB standard size) |
| `COLLATERAL_COINS` | Coins of 1001+ DASH kept for `mn` keys by merging small coins as soon as one is missing (default 0: no merging at all, and no `Retry-After` on a fragmented payout) |
| `AUTH_ORIGIN` | Origin that serves login, `/keys` and `/admin`; blank disables login |
| `AUTH_EMAIL_DOMAIN` / `AUTH_GITHUB_ORG` | Who may sign in (default `dash.org` / `dashpay`) |
| `AUTH_ADMINS` | Comma-separated `google:<email>` / `github:<numeric id>` admins |
| `SELF_SERVE_KEY_TTL_DAYS` / `MAX_KEYS_PER_USER` | Self-serve key lifetime (180) and per-person cap (5) |
| `SESSION_SECRET` | **secret**, ≥32 characters. Signs session and OAuth-state cookies; rotating it signs everyone out |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **secrets**. Google OAuth web client; redirect URI `AUTH_ORIGIN/auth/google/callback` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | **secrets**. GitHub OAuth app; callback `AUTH_ORIGIN/auth/github/callback` |
| `DRY_RUN` | `1` builds and signs but never broadcasts |
| `FAUCET_WIF` | **secret** — the faucet's hot key |
| `TURNSTILE_SECRET` | **secret** — blank disables captcha verification |
| `CAP_SECRET` | **secret** — HMAC key for the proof-of-work captcha; blank disables it |
| `INVITATION_SECRET` | **secret** — encrypts bearer WIFs and HMACs IP/device signals; required when invitations are enabled |
| `INVITATION_FAUCET_WIF` | **secret** — separate invitation hot key; required when `INVITATION_NETWORK` differs from `NETWORK` |

### Security

`FAUCET_WIF` is a hot key on infrastructure you do not control. Keep the mainnet
float thin and top it up from cold storage. `DAILY_BUDGET_SATS` is enforced in
the Durable Object and is the hard ceiling on what a single day can cost you,
regardless of how the limits above it are defeated.

Invitation asset locks are irreversible once broadcast and are intentionally
outside `DAILY_BUDGET_SATS`; control their maximum cost with a thin faucet
balance and a small `INVITATION_INVENTORY_TARGET`. Enabling invitations also
requires a non-empty Turnstile site key and secret. Keep `INVITATION_SECRET`
stable and backed up for as long as unclaimed inventory exists—losing or
rotating it makes those stored WIFs unrecoverable.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # add a funded testnet WIF
npm run dev                      # wrangler dev --env testnet

npm test          # unit tests
npm run typecheck # Worker and test type checking
node scripts/verify-testnet.mjs  # end-to-end against live testnet explorers
```

### Deploy

GitHub Actions validates pushes and pull requests with type checks, unit/Worker
tests, browser tests, and a Wrangler build. After validation, pushes to `master`
automatically deploy the testnet Worker and its static assets, then check both
public hostnames. Deployments run one at a time and skip superseded revisions.
Feature branches and pull requests only run validation.

One-time setup in this repository's **Settings → Secrets and variables → Actions**:

- Add the Actions secret `CLOUDFLARE_API_TOKEN`. Use Cloudflare's **Edit Cloudflare
  Workers** API-token template, scoped to the existing faucet account and the
  `dashhq.org` and `thepasta.org` zones used by its custom domains.
- Add the Actions variable `CLOUDFLARE_ACCOUNT_ID` for that account.

The login secrets are the exception. Set them in the `testnet` environment as
`SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`OAUTH_GITHUB_CLIENT_ID` and `OAUTH_GITHUB_CLIENT_SECRET` (GitHub reserves the
`GITHUB_` prefix). Each deploy uploads the ones that are set with `wrangler
deploy --secrets-file`, so changing one means setting it and re-running the
workflow. A provider whose credentials are missing is simply not offered.

Existing Worker secrets remain in Cloudflare; GitHub does not need the wallet
keys or CAPTCHA secrets. To retry a deployment after updating credentials, use
**Actions → Validate and deploy faucet → Run workflow**, selecting `master`.
The workflow deploys only the `testnet` Wrangler environment, which also hosts
the invitation faucet.

For an initial setup or a manual deployment from an authenticated local shell:

```bash
npx wrangler secret put FAUCET_WIF --env testnet
npx wrangler secret put TURNSTILE_SECRET --env testnet
npx wrangler secret put CAP_SECRET --env testnet   # any high-entropy string
npx wrangler secret put INVITATION_SECRET --env testnet
npx wrangler secret put INVITATION_FAUCET_WIF --env testnet
npm run deploy:testnet
```

The production testnet Worker uses `FAUCET_WIF` for tDASH payouts and
`INVITATION_FAUCET_WIF` for its isolated mainnet invitation actor. Both public
hostnames point to that Worker. The separate `mainnet` Wrangler environment is
kept disabled and unrouted; it is not the public invitation backend.

## Notes

`dashtx`'s ESM entry (`dashtx.mjs`) evaluates a bare `window`, which is a
`ReferenceError` anywhere that is not a browser — `workerd` included. Both
`wrangler.jsonc` and `vitest.config.ts` alias the package to its guarded
CommonJS build. Do not remove those aliases.

Every outbound request sends a `User-Agent`. Workers' `fetch` sends none by
default and `hyphen.dash.org` answers such requests with an HTTP 520, which
silently disables the primary mainnet provider. Hyphen also returns 404 for an
address with no history, meaning "empty" rather than "unavailable", and caps
`limit` at 100 with a non-functional `offset` — so a truncated page is treated
as an error rather than as a smaller balance.

Rotating `CAP_SECRET` invalidates every outstanding challenge and unspent
capToken. That is harmless — clients simply fetch a new challenge — and it is
also the way to revoke tokens in bulk, since none of them are stored.

A broadcast that neither succeeds nor is explicitly rejected — a timeout, a
5xx — is treated as *ambiguous*: the transaction may be live. Those inputs are
locked rather than released, because releasing them would let a retry build a
second, different transaction and pay twice. See `settleBroadcast` in
`src/treasury.ts`.

## License

MIT
