# Dash Faucet — serverless

A Dash faucet that runs entirely on Cloudflare Workers' free tier. It builds,
signs and broadcasts payouts itself, so there is no Dash Core node, no captcha
container, and no tunnel to keep alive. The only external dependencies are
public block explorers, and it fails over between several of them.

It can also run an optional identity-invitation faucet. That path pre-creates
ChainLocked 0.003 DASH asset locks and gives a wallet everything it needs to
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
            Chain layer (src/chain/) ──► hyphen ┐
                                      ──► insight ├─ ordered failover
                                      ──► dashrpc ┘
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
| Dash JSON-RPC | `rpc.digitalcash.dev` | `trpc.digitalcash.dev` | ✓ | ✓ |

Reads take the first healthy provider that is not lagging the best-known tip;
refusing a stale provider is what stops the faucet spending coins the rest of
the network already knows are gone. Broadcasts are fanned out to every
relay-capable provider at once, which removes the single point of failure and
improves propagation. "Already in mempool" counts as success, not failure.

### The UTXO pool

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

Send `turnstileToken` from the browser, or `capToken` from a native client.
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

### `POST /api/invitation-faucet`

Enabled only when `INVITATIONS_ENABLED=1`. It requires a Turnstile token bound
to the `invitation_faucet` action; proof-of-work tokens are not accepted.

```bash
curl -X POST https://faucet.example/api/invitation-faucet \
  -H 'content-type: application/json' \
  -d '{"turnstileToken":"..."}'
```

```json
{
  "invitation": "dashpay://invite?assetlocktx=...&pk=...&islock=null",
  "txid": "...",
  "amount": 0.003,
  "expiresAt": 1787000000000,
  "replay": false,
  "network": "mainnet"
}
```

The Treasury builds version-3/type-8 asset-lock transactions in advance and
does not make them available until Dash Core reports that their containing
block is ChainLocked. The wallet reconstructs a `ChainAssetLockProof` from the
transaction; no InstantLock payload is required.

This is a pure funding voucher: it does not select a username. The wallet asks
the recipient to choose a currently available, non-contested name during the
claim flow. In the legacy invitation format, the optional `du` field identifies
the inviter for contact bootstrap; using it for the recipient's desired name
would be incorrect.

Each normalized IP and signed `HttpOnly` device cookie gets one issuance per
seven days. The IP and device values are stored only as keyed HMACs. Repeating
a request from the same device during its reservation returns the same
invitation instead of consuming another one.

An invitation is a bearer private key. The WIF is AES-GCM encrypted at rest and
is returned only in the no-store API response. After 60 minutes, maintenance
checks the prospective identity ID. A claimed invitation is retired and its
encrypted key erased; an unclaimed one goes back into inventory. This recovery
is intentionally simple and racy: after expiry, the old recipient and a new
recipient may both have the key, and whichever wallet claims the asset lock
first wins. The browser clearly marks the reservation expired at 60 minutes;
the cron may take up to its next run to recycle it.

Compatibility note: current Android releases structurally require a `du` field
and still gate non-contested invitation claims at 0.03 DASH in the username UI,
even though the protocol-side invitation minimum is 0.003 DASH. Android must
accept inviter-less links and use the 0.003-DASH invitation floor before these
faucet vouchers can be claimed there. The faucet deliberately does not increase
the real-money voucher tenfold to accommodate that stale UI check.

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
version and SRI, loaded only after a `429`, and left to its own click-to-start
UI, since a WASM Web Worker pool chewing through 839M hashes is a minute of the
visitor's CPU. Each capToken is single-use, so one hard solve buys exactly one
payout.

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
| `INVITATIONS_ENABLED` | `1` enables the identity-invitation API and UI; disabled by default |
| `INVITATION_INVENTORY_TARGET` | Number of ready or preparing invitations to keep on hand (default 3) |
| `INVITATION_TTL_SECS` | Recipient reservation time before recovery (default 3600) |
| `INVITATION_RATE_WINDOW_SECS` | Per-IP and per-device issuance window (default 604800 / seven days) |
| `PLATFORM_EXPLORER_URL` | Network-appropriate Platform Explorer base URL for identity claim checks |
| `DRY_RUN` | `1` builds and signs but never broadcasts |
| `FAUCET_WIF` | **secret** — the faucet's hot key |
| `TURNSTILE_SECRET` | **secret** — blank disables captcha verification |
| `CAP_SECRET` | **secret** — HMAC key for the proof-of-work captcha; blank disables it |
| `INVITATION_SECRET` | **secret** — encrypts bearer WIFs and HMACs IP/device signals; required when invitations are enabled |

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

```bash
npx wrangler secret put FAUCET_WIF --env testnet
npx wrangler secret put TURNSTILE_SECRET --env testnet
npx wrangler secret put CAP_SECRET --env testnet   # any high-entropy string
npx wrangler secret put INVITATION_SECRET --env testnet
npm run deploy:testnet
```

Same for `--env mainnet` / `npm run deploy:mainnet`.

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
