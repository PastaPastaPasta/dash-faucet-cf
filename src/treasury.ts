import { DurableObject } from "cloudflare:workers";
import DashTx from "dashtx";
import { ChainClient, ProviderStatus, UtxoSnapshot } from "./chain";
import {
  Env,
  FaucetConfig,
  ProofTier,
  resolveConfig,
  resolveInvitationTreasuryConfig,
} from "./config";
import { describeError } from "./errors";
import {
  decryptWif,
  encryptWif,
  generateVoucherKey,
  invitationUri,
  prospectiveIdentityId,
} from "./invitation";
import { FaucetKey, loadFaucetKey } from "./keys";
import { platformIdentityExists } from "./platform";
import {
  BuiltTx,
  InsufficientFundsError,
  SelfPayError,
  buildPayout,
  buildSplit,
  buildInvitationAssetLock,
} from "./tx";

/**
 * Name of the one global Treasury instance that owns all spending for a
 * deployment. Lives here rather than in the Worker entry module because workerd
 * rejects any named export from the entry that is not a handler or a class.
 */
export const TREASURY_ID = "faucet-v1";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Grace period before a `spent` row whose outpoint has disappeared from the
 * explorers is dropped. Absence means the spend is now reflected on-chain, so
 * the row has done its job.
 */
const SPENT_SETTLED_MS = 30 * 60_000;
/**
 * How long a `spent` row survives while its outpoint is *still* listed as
 * unspent by the explorers. That combination means our transaction never made
 * it, so the coin is eventually released back into circulation.
 */
const SPENT_STALE_MS = 24 * HOUR_MS;
/**
 * How long an unconfirmed output of ours stays authoritative over explorers.
 *
 * A `pending` row only has to bridge broadcast to confirmation — one block, or
 * a handful under congestion — so an hour is already generous. The two failure
 * directions are not symmetric: dropping a live row costs a temporary
 * under-count, because a coin that really exists comes back the moment the
 * explorers list it, while keeping a dead one inflates the balance and offers a
 * phantom outpoint to coin selection, which then builds a transaction spending
 * an input that no longer exists. Prefer to drop early.
 */
const PENDING_TTL_MS = HOUR_MS;

export interface PayoutRequest {
  address: string;
  pubKeyHash: string;
  ip: string;
  /**
   * Strength of the proof the caller already verified. Only the ceiling the
   * hourly hit count is measured against depends on it; the count itself is
   * per-IP and tier-blind, so escalating raises the same allowance rather than
   * opening a second one. Defaults to the weakest tier, which is also what an
   * unauthenticated deployment (no captcha configured at all) gets.
   */
  tier?: ProofTier;
}

export type PayoutResult =
  | {
      ok: true;
      txid: string;
      satoshis: number;
      replay: boolean;
      dryRun: boolean;
      accepted: string[];
    }
  | { ok: false; code: "rate_limited"; retryAfter: number }
  | { ok: false; code: "budget_exhausted"; retryAfter: number }
  | { ok: false; code: "insufficient_funds"; detail: string }
  | { ok: false; code: "self_pay"; detail: string }
  | { ok: false; code: "chain_unavailable"; detail: string }
  | { ok: false; code: "error"; detail: string };

export interface Snapshot {
  address: string;
  balanceSats: number;
  availableUtxos: number;
  poolUtxos: number;
  blockHeight: number;
  source: string;
  providers: ProviderStatus[];
  spentToday: number;
  invitations: {
    available: number;
    preparing: number;
    issued: number;
  };
}

export interface MaintenanceResult {
  action: "none" | "split" | "blocked";
  detail: string;
  txid?: string;
}

export interface InvitationIssueRequest {
  ipHash: string;
  deviceHash: string;
}

export type InvitationIssueResult =
  | {
      ok: true;
      uri: string;
      txid: string;
      expiresAt: number;
      replay: boolean;
    }
  | { ok: false; code: "rate_limited"; retryAfter: number }
  | { ok: false; code: "unavailable" }
  | { ok: false; code: "platform_unavailable" }
  | { ok: false; code: "error"; detail: string };

export interface InvitationMaintenanceResult {
  action: "disabled" | "none" | "updated" | "minted" | "blocked";
  detail: string;
}

type BroadcastSettlement =
  | { ok: true; accepted: string[] }
  | { ok: false; result: PayoutResult; uncertain: boolean };

interface InvitationRow {
  [key: string]: string | number | null;
  id: string;
  txid: string;
  built_json: string;
  cipher_hex: string;
  iv_hex: string;
  prospective_identity_id: string;
  state: string;
  chain_locked_height: number | null;
  device_hash: string | null;
  issued_at: number | null;
  created_at: number;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/**
 * Single global actor that owns the faucet's spending.
 *
 * Durable Objects are single-threaded, but `await` still yields, so every
 * mutating path runs through `serialize()`. That is what actually prevents two
 * concurrent requests from selecting the same coin and building conflicting
 * transactions — the thing a stateless worker cannot do.
 */
export class Treasury extends DurableObject<Env> {
  private config: FaucetConfig;
  private chain: ChainClient;
  private keyPromise: Promise<FaucetKey> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    ctx: DurableObjectState,
    env: Env,
    config: FaucetConfig = resolveConfig(env),
  ) {
    super(ctx, env);
    this.config = config;
    this.chain = new ChainClient(this.config.providers);
    this.migrate();
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        recipient  TEXT    NOT NULL,
        day        TEXT    NOT NULL,
        txid       TEXT    NOT NULL,
        satoshis   INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (recipient, day)
      );
      CREATE TABLE IF NOT EXISTS ip_hits (
        ip         TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ip_hits_lookup ON ip_hits (ip, created_at);
      CREATE TABLE IF NOT EXISTS spent (
        txid       TEXT    NOT NULL,
        vout       INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (txid, vout)
      );
      CREATE TABLE IF NOT EXISTS pending (
        txid       TEXT    NOT NULL,
        vout       INTEGER NOT NULL,
        satoshis   INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (txid, vout)
      );
      CREATE TABLE IF NOT EXISTS budget (
        day      TEXT    PRIMARY KEY,
        satoshis INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_cap (
        token      TEXT    PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitation_inventory (
        id                      TEXT    PRIMARY KEY,
        txid                    TEXT    NOT NULL UNIQUE,
        built_json              TEXT    NOT NULL,
        cipher_hex              TEXT    NOT NULL,
        iv_hex                  TEXT    NOT NULL,
        prospective_identity_id TEXT    NOT NULL,
        state                   TEXT    NOT NULL,
        chain_locked_height     INTEGER,
        device_hash             TEXT,
        issued_at               INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS invitation_inventory_state
        ON invitation_inventory (state, created_at);
      CREATE TABLE IF NOT EXISTS invitation_hits (
        kind       TEXT    NOT NULL,
        value_hash TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS invitation_hits_lookup
        ON invitation_hits (kind, value_hash, created_at);
    `);
  }

  private key(): Promise<FaucetKey> {
    if (!this.keyPromise) {
      this.keyPromise = loadFaucetKey(this.config.wif, this.config.network);
    }
    return this.keyPromise;
  }

  /** Run `fn` with exclusive access to the spending path. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Time-based cleanup. Synchronous, and only called inside `serialize()`. */
  private prune(now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM ip_hits WHERE created_at < ?`, now - HOUR_MS);
    sql.exec(`DELETE FROM claims WHERE created_at < ?`, now - 7 * DAY_MS);
    sql.exec(`DELETE FROM budget WHERE day < ?`, utcDay(now - 7 * DAY_MS));
    // A capToken past its own expiry can never be accepted again, so the row
    // proving it was spent has nothing left to protect.
    sql.exec(`DELETE FROM used_cap WHERE expires_at < ?`, now);
    sql.exec(
      `DELETE FROM invitation_hits WHERE created_at < ?`,
      now - this.config.invitations.rateWindowMs,
    );

    // A pending output this old either confirmed long ago (in which case the
    // explorers now carry it and the row is redundant) or never landed. Log the
    // latter: it is the only way a coin quietly leaves our view.
    const stale = sql
      .exec<{ txid: string; vout: number; satoshis: number }>(
        `SELECT txid, vout, satoshis FROM pending WHERE created_at < ?`,
        now - PENDING_TTL_MS,
      )
      .toArray();
    if (stale.length > 0) {
      console.warn(
        `treasury: dropping ${stale.length} pending output(s) past TTL: ` +
          stale.map((r) => `${outpointKey(r.txid, r.vout)}=${r.satoshis}`).join(", "),
      );
      sql.exec(`DELETE FROM pending WHERE created_at < ?`, now - PENDING_TTL_MS);
    }
  }

  /**
   * Reconcile the local in-flight ledger against what the explorers can see.
   *
   * A `spent` row is only needed while the explorers still believe its outpoint
   * is unspent. Once it disappears from their view the spend has landed and the
   * row can go; if it is *still* there long afterwards, our transaction never
   * made it and the coin should be released rather than locked forever.
   */
  private reconcile(confirmed: Set<string>, now: number): void {
    const sql = this.ctx.storage.sql;
    for (const row of sql
      .exec<{ txid: string; vout: number; created_at: number }>(
        `SELECT txid, vout, created_at FROM spent`,
      )
      .toArray()) {
      const key = outpointKey(row.txid, row.vout);
      const age = now - row.created_at;
      const stillUnspent = confirmed.has(key);
      if (!stillUnspent && age > SPENT_SETTLED_MS) {
        sql.exec(`DELETE FROM spent WHERE txid = ? AND vout = ?`, row.txid, row.vout);
        // The same outpoint may also sit in `pending` — our own change, spent
        // again before the explorers ever listed it as unspent. Such a row is
        // never cleared by the `confirmed` check below, because the outpoint
        // goes straight from unknown to consumed without appearing in their
        // UTXO set. Dropping it here, with the `spent` row that was masking it,
        // is what stops it outliving its guard and reappearing as a phantom
        // coin for the rest of PENDING_TTL_MS.
        sql.exec(`DELETE FROM pending WHERE txid = ? AND vout = ?`, row.txid, row.vout);
      } else if (stillUnspent && age > SPENT_STALE_MS) {
        console.warn(`treasury: releasing never-spent outpoint ${key}`);
        sql.exec(`DELETE FROM spent WHERE txid = ? AND vout = ?`, row.txid, row.vout);
      }
    }
    // A pending output the explorers now report is redundant.
    for (const row of sql
      .exec<{ txid: string; vout: number }>(`SELECT txid, vout FROM pending`)
      .toArray()) {
      if (confirmed.has(outpointKey(row.txid, row.vout))) {
        sql.exec(`DELETE FROM pending WHERE txid = ? AND vout = ?`, row.txid, row.vout);
      }
    }
  }

  /**
   * Confirmed coins from the explorers, plus our own in-flight outputs, minus
   * outpoints we have already spent. The local ledger wins over the explorers:
   * it knows about transactions they have not indexed yet.
   */
  private async spendableUtxos(key: FaucetKey, now: number): Promise<UtxoSnapshot> {
    const snapshot = await this.chain.getUtxos(key.address);
    const sql = this.ctx.storage.sql;

    const confirmed = new Set(
      snapshot.utxos.map((u) => outpointKey(u.txid, u.outputIndex)),
    );
    this.reconcile(confirmed, now);

    const spent = new Set<string>();
    for (const row of sql.exec<{ txid: string; vout: number }>(
      `SELECT txid, vout FROM spent`,
    )) {
      spent.add(outpointKey(row.txid, row.vout));
    }

    const script = DashTx.createPkhScript(key.pubKeyHash);
    const merged = new Map(
      snapshot.utxos.map((u) => [outpointKey(u.txid, u.outputIndex), u] as const),
    );
    for (const row of sql.exec<{ txid: string; vout: number; satoshis: number }>(
      `SELECT txid, vout, satoshis FROM pending`,
    )) {
      const k = outpointKey(row.txid, row.vout);
      if (merged.has(k)) continue; // already confirmed and reported
      merged.set(k, {
        txid: row.txid,
        outputIndex: row.vout,
        satoshis: row.satoshis,
        script,
        height: null,
      });
    }
    for (const k of spent) merged.delete(k);

    return { ...snapshot, utxos: [...merged.values()] };
  }

  /** Mark a transaction's inputs as consumed, without claiming its outputs. */
  private lockInputs(built: BuiltTx, now: number): void {
    for (const input of built.inputs) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO spent (txid, vout, created_at) VALUES (?, ?, ?)`,
        input.txid,
        input.outputIndex,
        now,
      );
    }
  }

  private recordSpend(built: BuiltTx, now: number): void {
    this.lockInputs(built, now);
    for (const out of built.ownOutputs) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO pending (txid, vout, satoshis, created_at) VALUES (?, ?, ?, ?)`,
        out.txid,
        out.outputIndex,
        out.satoshis,
        now,
      );
    }
  }

  private spentToday(day: string): number {
    const row = this.ctx.storage.sql
      .exec<{ satoshis: number }>(`SELECT satoshis FROM budget WHERE day = ?`, day)
      .toArray()[0];
    return row?.satoshis ?? 0;
  }

  /**
   * Burn a capToken, returning false if it was already spent.
   *
   * capTokens are self-verifying, so this table is the *only* captcha state the
   * faucet keeps: a spent-set, not a session store. It lives in the Treasury
   * because the Treasury is already the one place with durable storage and a
   * single thread.
   *
   * Deliberately not wrapped in `serialize()`. There is no `await` between the
   * read and the write, so the Durable Object's single thread makes the pair
   * atomic on its own; taking the spending lock would only make every request
   * queue behind an in-flight broadcast for no added safety. For the same
   * reason this prunes only its own table and leaves the coin ledger to
   * `prune()`, which runs under the lock.
   */
  async consumeCapToken(token: string, expiresAt: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM used_cap WHERE expires_at < ?`, Date.now());

    const seen = sql
      .exec(`SELECT 1 FROM used_cap WHERE token = ?`, token)
      .toArray();
    if (seen.length > 0) return false;

    sql.exec(
      `INSERT INTO used_cap (token, expires_at) VALUES (?, ?)`,
      token,
      expiresAt,
    );
    return true;
  }

  async payout(input: PayoutRequest): Promise<PayoutResult> {
    return this.serialize(() => this.payoutLocked(input));
  }

  private async payoutLocked(input: PayoutRequest): Promise<PayoutResult> {
    const now = Date.now();
    const day = utcDay(now);
    const sql = this.ctx.storage.sql;
    const cfg = this.config;

    this.prune(now);

    // 1. Idempotency. A repeated request for the same address on the same day
    //    returns the original transaction instead of paying twice.
    const prior = sql
      .exec<{ txid: string; satoshis: number }>(
        `SELECT txid, satoshis FROM claims WHERE recipient = ? AND day = ?`,
        input.address,
        day,
      )
      .toArray()[0];
    if (prior) {
      return {
        ok: true,
        txid: prior.txid,
        satoshis: prior.satoshis,
        replay: true,
        dryRun: false,
        accepted: [],
      };
    }

    // 2. Durable per-IP limit, scaled by how strong a proof was presented.
    const limit = cfg.rateLimits[input.tier ?? "soft"];
    const hits = sql
      .exec<{ oldest: number | null; n: number }>(
        `SELECT MIN(created_at) AS oldest, COUNT(*) AS n
           FROM ip_hits WHERE ip = ? AND created_at > ?`,
        input.ip,
        now - HOUR_MS,
      )
      .toArray()[0];
    if (hits && hits.n >= limit) {
      const oldest = hits.oldest ?? now;
      const retryAfter = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
      return { ok: false, code: "rate_limited", retryAfter };
    }

    // 3. Global daily budget — the hard ceiling on a day's total loss.
    const spent = this.spentToday(day);
    if (spent + cfg.payoutSats > cfg.dailyBudgetSats) {
      const today = new Date(now);
      const midnight = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      );
      return {
        ok: false,
        code: "budget_exhausted",
        retryAfter: Math.max(1, Math.ceil((midnight - now) / 1000)),
      };
    }

    const key = await this.key();

    let view: UtxoSnapshot;
    try {
      view = await this.spendableUtxos(key, now);
    } catch (err) {
      return { ok: false, code: "chain_unavailable", detail: describeError(err) };
    }

    let built: BuiltTx;
    try {
      built = await buildPayout({
        key,
        utxos: view.utxos,
        recipientPubKeyHash: input.pubKeyHash,
        satoshis: cfg.payoutSats,
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return { ok: false, code: "insufficient_funds", detail: err.message };
      }
      if (err instanceof SelfPayError) {
        return { ok: false, code: "self_pay", detail: err.message };
      }
      // Never forward raw library text to a client; log it for operators.
      console.error(`treasury: payout build failed: ${describeError(err)}`);
      return { ok: false, code: "error", detail: "could not build transaction" };
    }

    if (cfg.dryRun) {
      // Build and sign, but change no state and touch no network.
      return {
        ok: true,
        txid: built.txid,
        satoshis: cfg.payoutSats,
        replay: false,
        dryRun: true,
        accepted: [],
      };
    }

    const outcome = await this.settleBroadcast(built, now);
    if (!outcome.ok) return outcome.result;

    // 4. Commit. Everything below is local bookkeeping for an accepted tx.
    this.recordSpend(built, now);
    sql.exec(
      `INSERT OR REPLACE INTO claims (recipient, day, txid, satoshis, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.address,
      day,
      built.txid,
      cfg.payoutSats,
      now,
    );
    sql.exec(`INSERT INTO ip_hits (ip, created_at) VALUES (?, ?)`, input.ip, now);
    sql.exec(
      `INSERT INTO budget (day, satoshis) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET satoshis = satoshis + excluded.satoshis`,
      day,
      cfg.payoutSats,
    );

    return {
      ok: true,
      txid: built.txid,
      satoshis: cfg.payoutSats,
      replay: false,
      dryRun: false,
      accepted: outcome.accepted,
    };
  }

  /**
   * Broadcast and decide, unambiguously, whether the transaction is on the
   * network.
   *
   * The dangerous case is neither success nor rejection but *silence*: a relay
   * that accepted the transaction into its mempool and then failed to answer in
   * time. Releasing the inputs there would let a retry build a second, different
   * transaction — a double payment if it selects a different coin. So an
   * unresolved broadcast always locks its inputs, even though that costs us a
   * coin's liquidity until the ledger reconciles.
   */
  private async settleBroadcast(
    built: BuiltTx,
    now: number,
  ): Promise<BroadcastSettlement> {
    let result = await this.chain.broadcast(built.hex, built.txid);
    if (result.accepted.length > 0) return { ok: true, accepted: result.accepted };

    if (result.ambiguous.length > 0) {
      // Rebroadcasting identical bytes is idempotent — same txid, so it can
      // never double-pay — and often resolves a one-off timeout outright.
      result = await this.chain.broadcast(built.hex, built.txid);
      if (result.accepted.length > 0) {
        return { ok: true, accepted: result.accepted };
      }

      const known = await this.chain.anyKnowsTx(built.txid);
      if (known === true) return { ok: true, accepted: ["observed on-chain"] };

      this.lockInputs(built, now);
      console.error(
        `treasury: unresolved broadcast for ${built.txid}; inputs locked. ` +
          result.ambiguous.join(" | "),
      );
      return {
        ok: false,
        uncertain: true,
        result: {
          ok: false,
          code: "chain_unavailable",
          detail: "broadcast could not be confirmed, please retry",
        },
      };
    }

    // Every relay rejected it outright, so the transaction is on no mempool.
    const detail = result.rejected.join(" | ");
    if (/missing inputs|inputs-missingorspent|bad-txns-inputs/i.test(detail)) {
      // Our view of the coin was stale; burn it so the retry picks another.
      this.lockInputs(built, now);
      return {
        ok: false,
        uncertain: false,
        result: {
          ok: false,
          code: "chain_unavailable",
          detail: "stale coin view, please retry",
        },
      };
    }
    console.error(`treasury: broadcast rejected for ${built.txid}: ${detail}`);
    return {
      ok: false,
      uncertain: false,
      result: { ok: false, code: "chain_unavailable", detail: "broadcast rejected" },
    };
  }

  private invitationCounts(): Snapshot["invitations"] {
    const rows = this.ctx.storage.sql
      .exec<{ state: string; n: number }>(
        `SELECT state, COUNT(*) AS n
           FROM invitation_inventory
          WHERE state IN ('broadcast_unknown', 'awaiting_chainlock', 'available', 'issued')
          GROUP BY state`,
      )
      .toArray();
    const counts = new Map(rows.map((row) => [row.state, row.n]));
    return {
      available: counts.get("available") ?? 0,
      preparing:
        (counts.get("broadcast_unknown") ?? 0) +
        (counts.get("awaiting_chainlock") ?? 0),
      issued: counts.get("issued") ?? 0,
    };
  }

  async snapshot(): Promise<Snapshot> {
    return this.serialize(async () => {
      const key = await this.key();
      const now = Date.now();
      this.prune(now);
      const view = await this.spendableUtxos(key, now);

      return {
        address: key.address,
        balanceSats: view.utxos.reduce((acc, u) => acc + u.satoshis, 0),
        availableUtxos: view.utxos.length,
        poolUtxos: view.utxos.filter((u) => u.satoshis >= this.config.poolUtxoSats)
          .length,
        blockHeight: view.tipHeight,
        source: view.source,
        providers: view.statuses,
        spentToday: this.spentToday(utcDay(now)),
        invitations: this.invitationCounts(),
      };
    });
  }

  async issueInvitation(
    input: InvitationIssueRequest,
  ): Promise<InvitationIssueResult> {
    return this.serialize(() => this.issueInvitationLocked(input));
  }

  private async issueInvitationLocked(
    input: InvitationIssueRequest,
  ): Promise<InvitationIssueResult> {
    const cfg = this.config.invitations;
    if (!cfg.enabled) return { ok: false, code: "unavailable" };

    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.prune(now);

    // A lost HTTP response must not burn a second voucher. Only the same signed
    // device cookie can replay a still-live disclosure.
    const prior = sql
      .exec<InvitationRow>(
        `SELECT * FROM invitation_inventory
          WHERE state = 'issued' AND device_hash = ? AND issued_at > ?
          ORDER BY issued_at DESC LIMIT 1`,
        input.deviceHash,
        now - cfg.ttlMs,
      )
      .toArray()[0];
    if (prior) {
      try {
        const wif = await decryptWif(
          { cipherHex: prior.cipher_hex, ivHex: prior.iv_hex },
          cfg.secret,
        );
        return {
          ok: true,
          uri: invitationUri(prior.txid, wif),
          txid: prior.txid,
          expiresAt: prior.issued_at! + cfg.ttlMs,
          replay: true,
        };
      } catch (err) {
        console.error(`treasury: invitation replay decrypt failed: ${describeError(err)}`);
        return { ok: false, code: "error", detail: "invitation could not be opened" };
      }
    }

    let retryAfter = 0;
    for (const [kind, valueHash] of [
      ["ip", input.ipHash],
      ["device", input.deviceHash],
    ] as const) {
      const hit = sql
        .exec<{ oldest: number | null; n: number }>(
          `SELECT MIN(created_at) AS oldest, COUNT(*) AS n
             FROM invitation_hits
            WHERE kind = ? AND value_hash = ? AND created_at > ?`,
          kind,
          valueHash,
          now - cfg.rateWindowMs,
        )
        .toArray()[0];
      if (hit && hit.n > 0) {
        retryAfter = Math.max(
          retryAfter,
          Math.max(
            1,
            Math.ceil(((hit.oldest ?? now) + cfg.rateWindowMs - now) / 1000),
          ),
        );
      }
    }
    if (retryAfter > 0) return { ok: false, code: "rate_limited", retryAfter };

    // Retire any voucher an old holder claimed after it was recycled. The
    // subsequent UPDATE is still serialized with this check; only an external
    // holder can race us, which is the intentionally accepted bearer race.
    for (;;) {
      const row = sql
        .exec<InvitationRow>(
          `SELECT * FROM invitation_inventory
            WHERE state = 'available' ORDER BY created_at LIMIT 1`,
        )
        .toArray()[0];
      if (!row) return { ok: false, code: "unavailable" };

      const claimed = await platformIdentityExists(
        cfg.platformExplorerUrl,
        row.prospective_identity_id,
      );
      if (claimed === null) return { ok: false, code: "platform_unavailable" };
      if (claimed) {
        sql.exec(
          `UPDATE invitation_inventory
              SET state = 'claimed', cipher_hex = '', iv_hex = '', updated_at = ?
            WHERE id = ?`,
          now,
          row.id,
        );
        continue;
      }

      let wif: string;
      try {
        wif = await decryptWif(
          { cipherHex: row.cipher_hex, ivHex: row.iv_hex },
          cfg.secret,
        );
      } catch (err) {
        console.error(`treasury: invitation decrypt failed: ${describeError(err)}`);
        sql.exec(
          `UPDATE invitation_inventory SET state = 'failed', updated_at = ? WHERE id = ?`,
          now,
          row.id,
        );
        return { ok: false, code: "error", detail: "invitation could not be opened" };
      }

      sql.exec(
        `UPDATE invitation_inventory
            SET state = 'issued', device_hash = ?, issued_at = ?, updated_at = ?
          WHERE id = ?`,
        input.deviceHash,
        now,
        now,
        row.id,
      );
      sql.exec(
        `INSERT INTO invitation_hits (kind, value_hash, created_at) VALUES
          ('ip', ?, ?), ('device', ?, ?)`,
        input.ipHash,
        now,
        input.deviceHash,
        now,
      );

      return {
        ok: true,
        uri: invitationUri(row.txid, wif),
        txid: row.txid,
        expiresAt: now + cfg.ttlMs,
        replay: false,
      };
    }
  }

  async maintainInvitations(): Promise<InvitationMaintenanceResult> {
    return this.serialize(() => this.maintainInvitationsLocked());
  }

  private async maintainInvitationsLocked(): Promise<InvitationMaintenanceResult> {
    const cfg = this.config.invitations;
    if (!cfg.enabled) return { action: "disabled", detail: "invitations disabled" };
    if (this.config.dryRun) {
      return { action: "none", detail: "dry run: invitation inventory unchanged" };
    }

    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.prune(now);
    let recycled = 0;
    let claimed = 0;
    let advanced = 0;

    for (const row of sql
      .exec<InvitationRow>(
        `SELECT * FROM invitation_inventory
          WHERE state = 'issued' AND issued_at <= ?`,
        now - cfg.ttlMs,
      )
      .toArray()) {
      const exists = await platformIdentityExists(
        cfg.platformExplorerUrl,
        row.prospective_identity_id,
      );
      if (exists === null) continue;
      if (exists) {
        sql.exec(
          `UPDATE invitation_inventory
              SET state = 'claimed', cipher_hex = '', iv_hex = '', updated_at = ?
            WHERE id = ?`,
          now,
          row.id,
        );
        claimed += 1;
      } else {
        sql.exec(
          `UPDATE invitation_inventory
              SET state = 'available', device_hash = NULL,
                  issued_at = NULL, updated_at = ?
            WHERE id = ?`,
          now,
          row.id,
        );
        recycled += 1;
      }
    }

    for (const row of sql
      .exec<InvitationRow>(
        `SELECT * FROM invitation_inventory
          WHERE state IN ('broadcast_unknown', 'awaiting_chainlock')`,
      )
      .toArray()) {
      let status;
      try {
        status = await this.chain.getChainLockStatus(row.txid);
      } catch {
        continue;
      }

      if (status.chainLocked && status.height !== null) {
        if (row.state === "broadcast_unknown") {
          this.recordSpend(JSON.parse(row.built_json) as BuiltTx, now);
        }
        sql.exec(
          `UPDATE invitation_inventory
              SET state = 'available', chain_locked_height = ?, updated_at = ?
            WHERE id = ?`,
          status.height,
          now,
          row.id,
        );
        advanced += 1;
        continue;
      }

      if (row.state === "broadcast_unknown" && !status.known) {
        const built = JSON.parse(row.built_json) as BuiltTx;
        const outcome = await this.settleBroadcast(built, now);
        if (outcome.ok) {
          this.recordSpend(built, now);
          sql.exec(
            `UPDATE invitation_inventory
                SET state = 'awaiting_chainlock', updated_at = ? WHERE id = ?`,
            now,
            row.id,
          );
          advanced += 1;
        } else if (!outcome.uncertain) {
          sql.exec(
            `UPDATE invitation_inventory
                SET state = 'failed', cipher_hex = '', iv_hex = '', updated_at = ?
              WHERE id = ?`,
            now,
            row.id,
          );
        }
      }
    }

    const counts = this.invitationCounts();
    const inPipeline = counts.available + counts.preparing;
    let minted = 0;
    for (let i = inPipeline; i < cfg.inventoryTarget; i += 1) {
      const result = await this.mintInvitation(now);
      if (!result.ok) {
        return {
          action: minted > 0 ? "minted" : "blocked",
          detail:
            `${minted} voucher(s) minted; refill stopped: ` + result.detail,
        };
      }
      minted += 1;
    }

    if (minted > 0) {
      return { action: "minted", detail: `${minted} voucher(s) awaiting ChainLock` };
    }
    if (recycled + claimed + advanced > 0) {
      return {
        action: "updated",
        detail: `${advanced} ready, ${recycled} recycled, ${claimed} claimed`,
      };
    }
    return { action: "none", detail: "invitation inventory unchanged" };
  }

  private async mintInvitation(
    now: number,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const cfg = this.config.invitations;
    const key = await this.key();
    let view: UtxoSnapshot;
    try {
      view = await this.spendableUtxos(key, now);
    } catch (err) {
      return { ok: false, detail: describeError(err) };
    }

    const voucher = await generateVoucherKey(this.config.network);
    let built: BuiltTx;
    try {
      built = await buildInvitationAssetLock({
        key,
        utxos: view.utxos,
        voucherPublicKeyHash: voucher.publicKeyHash,
        satoshis: cfg.amountSats,
      });
    } catch (err) {
      voucher.privateKey.fill(0);
      return { ok: false, detail: describeError(err) };
    }

    const encrypted = await encryptWif(voucher.wif, cfg.secret);
    voucher.privateKey.fill(0);
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO invitation_inventory
        (id, txid, built_json, cipher_hex, iv_hex,
         prospective_identity_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'broadcast_unknown', ?, ?)`,
      id,
      built.txid,
      JSON.stringify(built),
      encrypted.cipherHex,
      encrypted.ivHex,
      prospectiveIdentityId(built.txid, 0),
      now,
      now,
    );

    const outcome = await this.settleBroadcast(built, now);
    if (outcome.ok) {
      this.recordSpend(built, now);
      this.ctx.storage.sql.exec(
        `UPDATE invitation_inventory
            SET state = 'awaiting_chainlock', updated_at = ? WHERE id = ?`,
        now,
        id,
      );
      return { ok: true };
    }

    this.ctx.storage.sql.exec(
      `UPDATE invitation_inventory
          SET state = ?, cipher_hex = CASE WHEN ? THEN cipher_hex ELSE '' END,
              iv_hex = CASE WHEN ? THEN iv_hex ELSE '' END, updated_at = ?
        WHERE id = ?`,
      outcome.uncertain ? "broadcast_unknown" : "failed",
      outcome.uncertain ? 1 : 0,
      outcome.uncertain ? 1 : 0,
      now,
      id,
    );
    return outcome.uncertain
      ? { ok: true }
      : { ok: false, detail: "asset-lock broadcast rejected" };
  }

  /** Cron entry point: keep enough independent pool coins to absorb bursts. */
  async maintain(): Promise<MaintenanceResult> {
    return this.serialize(() => this.maintainLocked());
  }

  private async maintainLocked(): Promise<MaintenanceResult> {
    const cfg = this.config;
    const now = Date.now();
    this.prune(now);

    const key = await this.key();
    let view: UtxoSnapshot;
    try {
      view = await this.spendableUtxos(key, now);
    } catch (err) {
      return { action: "blocked", detail: describeError(err) };
    }

    const pool = view.utxos.filter((u) => u.satoshis >= cfg.poolUtxoSats);
    if (pool.length >= cfg.poolMin) {
      return {
        action: "none",
        detail: `${pool.length} pool coins available (min ${cfg.poolMin})`,
      };
    }

    const biggest = [...view.utxos].sort((a, b) => b.satoshis - a.satoshis)[0];
    if (!biggest) {
      return { action: "blocked", detail: "no spendable coins" };
    }

    const wanted = cfg.poolTarget - pool.length;
    // Leave headroom for the fee; buildSplit re-checks exactly.
    const affordable = Math.floor((biggest.satoshis * 0.99) / cfg.poolUtxoSats);
    const count = Math.min(wanted, affordable);
    if (count < 2) {
      return {
        action: "blocked",
        detail: `largest coin (${biggest.satoshis} duffs) cannot fund 2 pool coins of ${cfg.poolUtxoSats}`,
      };
    }

    if (cfg.dryRun) {
      return { action: "none", detail: `dry run: would split into ${count}` };
    }

    let built: BuiltTx;
    try {
      built = await buildSplit({
        key,
        utxos: [biggest],
        count,
        perOutputSats: cfg.poolUtxoSats,
      });
    } catch (err) {
      return { action: "blocked", detail: describeError(err) };
    }

    const outcome = await this.settleBroadcast(built, now);
    if (!outcome.ok) {
      return { action: "blocked", detail: "split broadcast could not be confirmed" };
    }

    // recordSpend runs only after a confirmed-accepted broadcast.
    this.recordSpend(built, now);
    return {
      action: "split",
      detail: `split into ${count} coins of ${cfg.poolUtxoSats} duffs`,
      txid: built.txid,
    };
  }
}

/**
 * A physically separate actor for invitation money and state.
 *
 * It intentionally reuses Treasury's transaction and recovery machinery, but
 * resolves its signing key, network and providers from the invitation-specific
 * bindings. The public testnet faucet can therefore expose real-DASH vouchers
 * without either treasury ever selecting the other one's coins.
 */
export class InvitationTreasury extends Treasury {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, resolveInvitationTreasuryConfig(env));
  }
}
