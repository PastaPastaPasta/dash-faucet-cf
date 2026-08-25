# Dash Faucet — serverless

A Dash faucet that runs entirely on Cloudflare Workers' free tier. It builds,
signs and broadcasts payouts itself, so there is no Dash Core node, no captcha
container, and no tunnel to keep alive. The only external dependencies are
public block explorers, and it fails over between several of them.

This replaces the FastAPI + `dashd` + CAP + `cloudflared` stack in
[`PastaPastaPasta/dash-faucet`](https://github.com/PastaPastaPasta/dash-faucet).

## How it works

```
Browser ──► Worker (src/index.ts)
              │  Turnstile · address validation · edge rate limit
              ▼
            Treasury Durable Object (SQLite)
              │  durable limits · idempotency · in-flight coin tracking
              │  build → sign → broadcast
              ▼
            Chain layer (src/chain/) ──► hyphen ┐
                                      ──► insight ├─ ordered failover
                                      ──► dashrpc ┘
```

Transactions are built and signed in the Worker with
[`dashtx`](https://www.npmjs.com/package/dashtx),
[`dashkeys`](https://www.npmjs.com/package/dashkeys) and
[`@dashincubator/secp256k1`](https://www.npmjs.com/package/@dashincubator/secp256k1)
— three zero-dependency libraries that run unmodified on `workerd`. The whole
Worker is ~43 KiB gzipped, against a 3 MiB free-plan limit.

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
{ "error": "Rate limit exceeded", "retryAfter": 1800,
  "detail": { "error": "Rate limit exceeded", "retryAfter": 1800 } }
```

`400` invalid address or captcha · `429` rate limited or daily budget spent
(`Retry-After` set) · `503` insufficient funds or every explorer unreachable.

Requesting the same address twice in one UTC day returns the original `txid`
with `replay: true` rather than paying again.

## Configuration

Per-environment vars live in `wrangler.jsonc`; secrets are set with
`wrangler secret put`.

| Variable | Meaning |
|---|---|
| `NETWORK` | `mainnet` or `testnet` — selects address versions and providers |
| `PAYOUT_SATS` | Amount per request, in duffs |
| `RATE_LIMIT_PER_HOUR` | Durable per-IP limit (IPv6 bucketed to /48) |
| `DAILY_BUDGET_SATS` | Hard ceiling on total payouts per UTC day |
| `MIN_BALANCE_SATS` | Below this, status reports `low_balance` |
| `POOL_MIN` / `POOL_TARGET` / `POOL_UTXO_SATS` | Pool maintenance thresholds |
| `TURNSTILE_SITE_KEY` | Public key, served to the UI |
| `DRY_RUN` | `1` builds and signs but never broadcasts |
| `FAUCET_WIF` | **secret** — the faucet's hot key |
| `TURNSTILE_SECRET` | **secret** — blank disables captcha verification |

### Security

`FAUCET_WIF` is a hot key on infrastructure you do not control. Keep the mainnet
float thin and top it up from cold storage. `DAILY_BUDGET_SATS` is enforced in
the Durable Object and is the hard ceiling on what a single day can cost you,
regardless of how the limits above it are defeated.

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

A broadcast that neither succeeds nor is explicitly rejected — a timeout, a
5xx — is treated as *ambiguous*: the transaction may be live. Those inputs are
locked rather than released, because releasing them would let a retry build a
second, different transaction and pay twice. See `settleBroadcast` in
`src/treasury.ts`.

## License

MIT
