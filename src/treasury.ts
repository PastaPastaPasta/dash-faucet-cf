import { DurableObject } from "cloudflare:workers";
import DashTx from "dashtx";
import { ChainClient, ProviderStatus, Utxo, UtxoSnapshot } from "./chain";
import {
  Env,
  FaucetConfig,
  NetworkName,
  ProofTier,
  otherHotKeys,
  resolveConfig,
  resolveInvitationTreasuryConfig,
  resolveStarterTreasuryConfig,
  starterSuffix,
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
  /** Vouchers wanted; clamped to `invitations.maxPerRequest`. Default 1. */
  count?: number;
}

export interface IssuedInvitation {
  uri: string;
  txid: string;
  expiresAt: number;
}

export type InvitationIssueResult =
  | {
      ok: true;
      /** At least one entry; fewer than requested when inventory ran short. */
      invitations: IssuedInvitation[];
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
  | { ok: false; result: PayoutResult; uncertain: boolean; inputsGone?: boolean };

interface InvitationRow {
  [key: string]: string | number | null;
  id: string;
  txid: string;
  built_json: string;
  cipher_hex: string;
  iv_hex: string;
  prospective_identity_id: string;
  amount_sats: number | null;
  state: string;
  chain_locked_height: number | null;
  device_hash: string | null;
  issued_at: number | null;
  created_at: number;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight, when the daily budget resets. */
function untilUtcMidnight(now: number): number {
  const today = new Date(now);
  const midnight = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((midnight - now) / 1000));
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/** The credit output of an invitation asset lock: everything not fee or change. */
function voucherAmount(built: BuiltTx): number {
  const change = built.ownOutputs.reduce((sum, out) => sum + out.satoshis, 0);
  return built.totalIn - built.fee - change;
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
  protected readonly config: FaucetConfig;
  protected readonly chain: ChainClient;
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

    const columns = new Set(
      this.ctx.storage.sql
        .exec<{ name: string }>(`PRAGMA table_info(invitation_inventory)`)
        .toArray()
        .map((row) => row.name),
    );
    if (!columns.has("amount_sats")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE invitation_inventory ADD COLUMN amount_sats INTEGER`,
      );
    }
    this.backfillInvitationAmounts();
  }

  /**
   * Vouchers minted before the amount was configurable carry no `amount_sats`.
   * Recover it from the signed transaction, so issuance can tell a 0.003 DASH
   * voucher — which no released wallet will redeem — from a 0.03 one.
   */
  private backfillInvitationAmounts(): void {
    const sql = this.ctx.storage.sql;
    for (const row of sql
      .exec<{ id: string; built_json: string }>(
        `SELECT id, built_json FROM invitation_inventory WHERE amount_sats IS NULL`,
      )
      .toArray()) {
      sql.exec(
        `UPDATE invitation_inventory SET amount_sats = ? WHERE id = ?`,
        voucherAmount(JSON.parse(row.built_json) as BuiltTx),
        row.id,
      );
    }
  }

  protected key(): Promise<FaucetKey> {
    if (!this.keyPromise) {
      this.keyPromise = this.loadKey();
    }
    return this.keyPromise;
  }

  /**
   * An input a stored, still-unresolved transaction spends, which must stay
   * locked however long the explorers keep listing it as unspent.
   */
  protected isPinned(_txid: string, _vout: number): boolean {
    return false;
  }

  /** How a txid appears in logs. Subclasses whose payouts are private redact it. */
  protected logTxid(txid: string): string {
    return txid;
  }

  /** How relays' raw error text appears in logs. Subclasses whose payouts are private drop it. */
  protected logRelayText(text: string): string {
    return text;
  }

  /** Load the signing key. Subclasses may add checks. */
  protected loadKey(): Promise<FaucetKey> {
    return loadFaucetKey(this.config.wif, this.config.network);
  }

  /** Run `fn` with exclusive access to the spending path. */
  protected serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Time-based cleanup. Synchronous, and only called inside `serialize()`. */
  protected prune(now: number): void {
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
          stale
            .map((r) => `${this.logTxid(r.txid)}:${r.vout}=${r.satoshis}`)
            .join(", "),
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
      } else if (stillUnspent && age > SPENT_STALE_MS && !this.isPinned(row.txid, row.vout)) {
        console.warn(
          `treasury: releasing never-spent outpoint ${this.logTxid(row.txid)}:${row.vout}`,
        );
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
  protected async spendableUtxos(key: FaucetKey, now: number): Promise<UtxoSnapshot> {
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
  protected lockInputs(built: BuiltTx, now: number): void {
    for (const input of built.inputs) {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO spent (txid, vout, created_at) VALUES (?, ?, ?)`,
        input.txid,
        input.outputIndex,
        now,
      );
    }
  }

  protected recordSpend(built: BuiltTx, now: number): void {
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

  protected addToBudget(day: string, satoshis: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO budget (day, satoshis) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET satoshis = satoshis + excluded.satoshis`,
      day,
      satoshis,
    );
  }

  protected spentToday(day: string): number {
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
      return { ok: false, code: "budget_exhausted", retryAfter: untilUtcMidnight(now) };
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
    this.addToBudget(day, cfg.payoutSats);

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
  protected async settleBroadcast(
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
        `treasury: unresolved broadcast for ${this.logTxid(built.txid)}; inputs locked. ` +
          this.logRelayText(result.ambiguous.join(" | ")),
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
        inputsGone: true,
        result: {
          ok: false,
          code: "chain_unavailable",
          detail: "stale coin view, please retry",
        },
      };
    }
    console.error(
      `treasury: broadcast rejected for ${this.logTxid(built.txid)}: ${this.logRelayText(detail)}`,
    );
    return {
      ok: false,
      uncertain: false,
      result: { ok: false, code: "chain_unavailable", detail: "broadcast rejected" },
    };
  }

  /** Inventory at the configured voucher amount; other denominations are inert. */
  private invitationCounts(): Snapshot["invitations"] {
    const rows = this.ctx.storage.sql
      .exec<{ state: string; n: number }>(
        `SELECT state, COUNT(*) AS n
           FROM invitation_inventory
          WHERE state IN ('broadcast_unknown', 'awaiting_chainlock', 'available', 'issued')
            AND amount_sats = ?
          GROUP BY state`,
        this.config.invitations.amountSats,
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

  private async openVoucher(
    row: InvitationRow,
    expiresAt: number,
  ): Promise<IssuedInvitation> {
    const wif = await decryptWif(
      { cipherHex: row.cipher_hex, ivHex: row.iv_hex },
      this.config.invitations.secret,
    );
    return { uri: invitationUri(row.txid, wif), txid: row.txid, expiresAt };
  }

  private async issueInvitationLocked(
    input: InvitationIssueRequest,
  ): Promise<InvitationIssueResult> {
    const cfg = this.config.invitations;
    if (!cfg.enabled) return { ok: false, code: "unavailable" };
    const count = Math.max(1, Math.min(input.count ?? 1, cfg.maxPerRequest));

    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.prune(now);

    // Replay exists to protect the issuance window: without it, a lost HTTP
    // response would lock a device out until the window elapsed. With the
    // window disabled there is nothing to protect, and a repeat request must
    // hand out fresh vouchers so one operator can issue batch after batch.
    if (cfg.rateWindowMs > 0) {
      const prior = sql
        .exec<InvitationRow>(
          `SELECT * FROM invitation_inventory
            WHERE state = 'issued' AND device_hash = ? AND issued_at > ?
            ORDER BY issued_at DESC`,
          input.deviceHash,
          now - cfg.ttlMs,
        )
        .toArray();
      if (prior.length > 0) {
        try {
          const invitations: IssuedInvitation[] = [];
          for (const row of prior) {
            invitations.push(await this.openVoucher(row, row.issued_at! + cfg.ttlMs));
          }
          return { ok: true, invitations, replay: true };
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
    }

    // Retire any voucher an old holder claimed after it was recycled. The
    // subsequent UPDATE is still serialized with this check; only an external
    // holder can race us, which is the intentionally accepted bearer race.
    //
    // Candidates are checked against Platform in parallel: this whole method
    // holds the actor's lock, so twenty sequential explorer round-trips would
    // stall every other request behind one batch.
    const invitations: IssuedInvitation[] = [];
    let explorerDown = false;
    let decryptFailed = false;
    while (invitations.length < count && !explorerDown) {
      const rows = sql
        .exec<InvitationRow>(
          `SELECT * FROM invitation_inventory
            WHERE state = 'available' AND amount_sats = ?
            ORDER BY created_at LIMIT ?`,
          cfg.amountSats,
          count - invitations.length,
        )
        .toArray();
      if (rows.length === 0) break;

      const claims = await Promise.all(
        rows.map((row) =>
          platformIdentityExists(cfg.platformExplorerUrl, row.prospective_identity_id),
        ),
      );
      for (const [i, row] of rows.entries()) {
        const claimed = claims[i];
        if (claimed === null) {
          // Left 'available'; stop rather than re-select it on the next pass.
          explorerDown = true;
          continue;
        }
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

        let opened: IssuedInvitation;
        try {
          opened = await this.openVoucher(row, now + cfg.ttlMs);
        } catch (err) {
          console.error(`treasury: invitation decrypt failed: ${describeError(err)}`);
          sql.exec(
            `UPDATE invitation_inventory SET state = 'failed', updated_at = ? WHERE id = ?`,
            now,
            row.id,
          );
          decryptFailed = true;
          continue;
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
        invitations.push(opened);
      }
    }

    if (invitations.length === 0) {
      if (explorerDown) return { ok: false, code: "platform_unavailable" };
      if (decryptFailed) {
        return { ok: false, code: "error", detail: "invitation could not be opened" };
      }
      return { ok: false, code: "unavailable" };
    }

    // A batch is one issuance as far as the window is concerned.
    sql.exec(
      `INSERT INTO invitation_hits (kind, value_hash, created_at) VALUES
        ('ip', ?, ?), ('device', ?, ?)`,
      input.ipHash,
      now,
      input.deviceHash,
      now,
    );
    return { ok: true, invitations, replay: false };
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
    this.backfillInvitationAmounts();
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
         prospective_identity_id, amount_sats, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'broadcast_unknown', ?, ?)`,
      id,
      built.txid,
      JSON.stringify(built),
      encrypted.cipherHex,
      encrypted.ivHex,
      prospectiveIdentityId(built.txid, 0),
      cfg.amountSats,
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

  protected async maintainLocked(): Promise<MaintenanceResult> {
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

/** Name of the one Durable Object per starter class (one class per network). */
export const STARTER_TREASURY_ID = "starter-v1";

export interface StarterRedeemRequest {
  /** hex(SHA-256(token signature)), the only thing kept about a token */
  tokenHash: string;
  /** hex hash160 the token is bound to; the payout goes to its P2PKH */
  pubKeyHash: string;
}

export type StarterRedeemResult =
  | {
      ok: true;
      txid: string;
      satoshis: number;
      replay: boolean;
      dryRun: boolean;
    }
  | { ok: false; code: "budget_exhausted"; retryAfter: number }
  | {
      ok: false;
      code: "insufficient_funds" | "self_pay" | "chain_unavailable" | "error";
      detail: string;
    };

interface StarterRow {
  [key: string]: string | number | null;
  txid: string;
  built_json: string | null;
  paid: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
/** How long /api/status may show a starter treasury's cached snapshot. */
export const STATUS_SNAPSHOT_TTL_MS = 30_000;
/** Unresolved starter payouts the cron retries per run. */
const STARTER_SETTLE_PER_TICK = 5;

/**
 * Treasury for govhub starter credits on one network: its own hot key, coins,
 * daily budget and pool, so a starter never spends the tDASH faucet's or the
 * invitation actor's coins.
 *
 * Privacy: the only table of its own is `starter_redemptions`, which maps
 * SHA-256(token signature) to the payout txid, keeps the signed bytes only
 * while a broadcast is unresolved, and has no timestamps, IPs or addresses.
 * WITHOUT ROWID, so not even insertion order survives. The inherited `claims`
 * and `ip_hits` tables (the tDASH faucet's per-address and per-IP records) are
 * never written here.
 */
export abstract class StarterTreasury extends Treasury {
  constructor(ctx: DurableObjectState, env: Env, network: NetworkName) {
    super(ctx, env, resolveStarterTreasuryConfig(env, network));
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS starter_redemptions (
        token_hash TEXT    PRIMARY KEY,
        txid       TEXT    NOT NULL,
        built_json TEXT,
        paid       INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
    `);
  }

  /** Refuse a starter key that another treasury on this network also spends. */
  protected override async loadKey(): Promise<FaucetKey> {
    const { network, wif } = this.config;
    const name = `STARTER_WIF_${starterSuffix(network)}`;
    let key: FaucetKey;
    try {
      key = await loadFaucetKey(wif, network);
    } catch {
      throw new Error(`${name} is not a valid ${network} WIF`);
    }
    for (const other of otherHotKeys(this.env)) {
      if (other.network !== network) continue;
      const otherKey = await loadFaucetKey(other.wif, other.network).catch(() => null);
      if (otherKey?.pubKeyHash === key.pubKeyHash) {
        throw new Error(`${name} must be a different key from ${other.name}`);
      }
    }
    return key;
  }

  /**
   * Pay one verified starter token, at most once. The caller has already
   * verified the token; this only enforces single use, the daily budget and
   * safe broadcast.
   */
  async redeemStarter(input: StarterRedeemRequest): Promise<StarterRedeemResult> {
    if (!HEX64.test(input.tokenHash) || !HEX40.test(input.pubKeyHash)) {
      return { ok: false, code: "error", detail: "malformed redemption" };
    }
    return this.serialize(() => this.redeemStarterLocked(input));
  }

  private paid(txid: string, how: { replay?: boolean; dryRun?: boolean } = {}): StarterRedeemResult {
    return {
      ok: true,
      txid,
      satoshis: this.config.payoutSats,
      replay: how.replay ?? false,
      dryRun: how.dryRun ?? false,
    };
  }

  /**
   * Starter txids are kept out of logs: a txid names the funded address on
   * chain, and log lines carry timestamps the starter table deliberately lacks.
   */
  protected override logTxid(): string {
    return "<starter payout>";
  }

  /** A relay's error text may echo the txid (or the raw tx): log only that there was one. */
  protected override logRelayText(): string {
    return "<relay detail withheld>";
  }

  /**
   * Bookkeeping for a payout that is on the network. A payout that was just
   * accepted records its change as in flight; one resolved later (a retry, or
   * the cron) only locks its inputs, since its change may long since have
   * been spent and must not come back as a phantom coin.
   */
  private commitStarter(tokenHash: string, built: BuiltTx, now: number, late: boolean): void {
    if (late) this.lockInputs(built, now);
    else this.recordSpend(built, now);
    this.ctx.storage.sql.exec(
      `UPDATE starter_redemptions SET txid = ?, paid = 1, built_json = NULL WHERE token_hash = ?`,
      built.txid,
      tokenHash,
    );
  }

  /**
   * Every transaction ever built for an unpaid token, oldest first. Each one
   * spends a subset of its predecessor's inputs, so at most one can confirm;
   * all are kept so whichever did can still be recognised.
   */
  private candidates(row: { built_json: string | null }): BuiltTx[] | null {
    const parsed: unknown = row.built_json ? JSON.parse(row.built_json) : null;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      // Unreachable: unpaid rows always keep their bytes.
      console.error("treasury: unpaid starter row without transaction bytes");
      return null;
    }
    return parsed as BuiltTx[];
  }

  /** Last snapshot served to /api/status, and the refresh in flight, if any. */
  private statusCache: { at: number; value: Snapshot } | null = null;
  private statusRefresh: Promise<Snapshot> | null = null;

  /**
   * The snapshot /api/status shows: at most STATUS_SNAPSHOT_TTL_MS old.
   * `snapshot()` reads the explorers under the spending lock, so calling it on
   * every status request would let anyone polling status queue explorer reads
   * in front of redemptions. Here a cached value is served without the lock,
   * and concurrent callers share one refresh. (`snapshot()` stays exact for
   * callers that need the current state.)
   */
  async statusSnapshot(): Promise<Snapshot> {
    const cached = this.statusCache;
    if (cached && Date.now() - cached.at < STATUS_SNAPSHOT_TTL_MS) return cached.value;
    this.statusRefresh ??= this.snapshot()
      .then((value) => {
        this.statusCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.statusRefresh = null;
      });
    return this.statusRefresh;
  }

  protected override isPinned(txid: string, vout: number): boolean {
    for (const row of this.ctx.storage.sql
      .exec<{ built_json: string | null }>(
        `SELECT built_json FROM starter_redemptions WHERE paid = 0`,
      )
      .toArray()) {
      for (const built of this.candidates(row) ?? []) {
        if (built.inputs.some((i) => i.txid === txid && i.outputIndex === vout)) return true;
      }
    }
    return false;
  }

  /**
   * Try to finish a stored, unpaid payout: rebroadcast the latest candidate's
   * exact bytes (same txid, so this can never pay twice), and if relays reject
   * it, ask whether any candidate is on chain. Commits whichever is. `absent`
   * is true only when every explorer answered that no candidate is known.
   */
  private async finishStored(
    tokenHash: string,
    candidates: BuiltTx[],
    now: number,
  ): Promise<{ done: true; txid: string } | { done: false; absent: boolean }> {
    const latest = candidates[candidates.length - 1];
    const outcome = await this.settleBroadcast(latest, now);
    if (outcome.ok) {
      this.commitStarter(tokenHash, latest, now, true);
      return { done: true, txid: latest.txid };
    }
    if (outcome.uncertain) return { done: false, absent: false };
    // Rejected everywhere. That includes "inputs already spent", which is also
    // what a relay says once one of these transactions has been mined.
    let unanswered = false;
    for (const built of [...candidates].reverse()) {
      const known = await this.chain.anyKnowsTx(built.txid);
      if (known === true) {
        this.commitStarter(tokenHash, built, now, true);
        return { done: true, txid: built.txid };
      }
      if (known === null) unanswered = true;
    }
    return { done: false, absent: !unanswered };
  }

  /**
   * Resolve a row left by an unresolved broadcast. Returns the result to give
   * the client, or the coins a replacement may be built from.
   *
   * A replacement is only ever built from the stored transaction's OWN inputs
   * that the explorers still list as unspent, so the two conflict and at most
   * one can confirm. "Nobody knows the txid" is never trusted on its own: an
   * explorer that lags, or a node without txindex, says that about a mined
   * transaction too, and paying afresh from other coins would pay twice.
   */
  private async settleStarterRow(
    tokenHash: string,
    row: StarterRow,
    now: number,
  ): Promise<{ result: StarterRedeemResult } | { rebuildFrom: Utxo[]; candidates: BuiltTx[] }> {
    const unresolved = {
      result: {
        ok: false,
        code: "chain_unavailable",
        detail: "an earlier payout for this token is unresolved, please retry",
      },
    } as const;
    const candidates = this.candidates(row);
    if (!candidates) {
      return { result: { ok: false, code: "error", detail: "inconsistent starter record" } };
    }
    const finished = await this.finishStored(tokenHash, candidates, now);
    if (finished.done) return { result: this.paid(finished.txid, { replay: true }) };
    // Unless every explorer answered "not known", an earlier transaction may
    // still be in a mempool or mined: nothing may be built.
    if (!finished.absent) return unresolved;

    const key = await this.key();
    let confirmed: Utxo[];
    try {
      confirmed = (await this.chain.getUtxos(key.address)).utxos;
    } catch {
      return unresolved;
    }
    const latest = candidates[candidates.length - 1];
    const own = new Set(latest.inputs.map((i) => outpointKey(i.txid, i.outputIndex)));
    const rebuildFrom = confirmed.filter((u) => own.has(outpointKey(u.txid, u.outputIndex)));
    // None of its inputs is unspent. They are locked from the moment the row is
    // written and pinned while it is unpaid, so no other payout of ours took
    // them: one of this token's transactions was mined and the explorers have
    // not caught up. Nothing safe can be built; a later retry or cron finds it.
    if (rebuildFrom.length === 0) return unresolved;
    return { rebuildFrom, candidates };
  }

  private async redeemStarterLocked(
    input: StarterRedeemRequest,
  ): Promise<StarterRedeemResult> {
    const now = Date.now();
    const day = utcDay(now);
    const sql = this.ctx.storage.sql;
    const cfg = this.config;
    this.prune(now);

    // 1. Single use. A paid token replays its txid; an unresolved one finishes
    //    its own broadcast before anything new is built.
    const row = sql
      .exec<StarterRow>(
        `SELECT txid, built_json, paid FROM starter_redemptions WHERE token_hash = ?`,
        input.tokenHash,
      )
      .toArray()[0];
    if (row?.paid) return this.paid(row.txid, { replay: true });
    let rebuildFrom: Utxo[] | undefined;
    let earlier: BuiltTx[] = [];
    if (row) {
      const settled = await this.settleStarterRow(input.tokenHash, row, now);
      if ("result" in settled) return settled.result;
      rebuildFrom = settled.rebuildFrom;
      earlier = settled.candidates;
    }

    // 2. Daily budget, reserved when the payout is first recorded (so in-flight
    //    payouts count too). A replacement was reserved with its original.
    //    Refusing here leaves the token unused.
    if (!rebuildFrom && this.spentToday(day) + cfg.payoutSats > cfg.dailyBudgetSats) {
      return { ok: false, code: "budget_exhausted", retryAfter: untilUtcMidnight(now) };
    }

    const key = await this.key();
    let utxos = rebuildFrom;
    if (!utxos) {
      try {
        utxos = (await this.spendableUtxos(key, now)).utxos;
      } catch (err) {
        return { ok: false, code: "chain_unavailable", detail: describeError(err) };
      }
    }

    let built: BuiltTx;
    try {
      built = await buildPayout({
        key,
        utxos,
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
      console.error(`treasury: starter build failed: ${describeError(err)}`);
      return { ok: false, code: "error", detail: "could not build transaction" };
    }

    if (cfg.dryRun) {
      return this.paid(built.txid, { dryRun: true });
    }

    // 3. Record the token as taken BEFORE the transaction can reach a relay
    //    (the output gate holds the fetch until this write is durable), so a
    //    crash or an ambiguous broadcast can only be finished with these bytes
    //    or a replacement that conflicts with them. Its inputs are locked at the
    //    same moment, so no other payout can take them even after a crash.
    if (rebuildFrom) {
      sql.exec(
        `UPDATE starter_redemptions SET txid = ?, built_json = ? WHERE token_hash = ?`,
        built.txid,
        JSON.stringify([...earlier, built]),
        input.tokenHash,
      );
    } else {
      sql.exec(
        `INSERT INTO starter_redemptions (token_hash, txid, built_json, paid)
         VALUES (?, ?, ?, 0)`,
        input.tokenHash,
        built.txid,
        JSON.stringify([built]),
      );
      this.addToBudget(day, cfg.payoutSats);
    }
    this.lockInputs(built, now);

    const outcome = await this.settleBroadcast(built, now);
    if (outcome.ok) {
      this.commitStarter(input.tokenHash, built, now, false);
      return this.paid(built.txid);
    }
    if (!outcome.uncertain && !rebuildFrom) {
      // A first attempt on no mempool: nothing was paid, so the token stays
      // usable and its budget reservation is returned. (A rejected
      // replacement keeps its row: the rejection may be its conflict with
      // the original, which may yet confirm.)
      sql.exec(`DELETE FROM starter_redemptions WHERE token_hash = ?`, input.tokenHash);
      this.addToBudget(day, -cfg.payoutSats);
      // Its coins go back to the pool, unless the relays said they are gone.
      if (!outcome.inputsGone) {
        for (const i of built.inputs) {
          sql.exec(`DELETE FROM spent WHERE txid = ? AND vout = ?`, i.txid, i.outputIndex);
        }
      }
    }
    // Otherwise the row stays and the next attempt resumes from it.
    return starterChainFailure(outcome.result);
  }

  /**
   * Cron: finish payouts whose broadcast was left unresolved (so their signed
   * bytes do not outlive the need for them, even if the client never comes
   * back), then keep the pool topped up.
   */
  override async maintain(): Promise<MaintenanceResult> {
    return this.serialize(async () => {
      const now = Date.now();
      let finished = 0;
      let open = 0;
      // A few per tick, in random order: this holds the spending lock, and a
      // provider outage must not stall redemptions behind a long backlog.
      for (const row of this.ctx.storage.sql
        .exec<StarterRow & { token_hash: string }>(
          `SELECT token_hash, txid, built_json, paid FROM starter_redemptions
            WHERE paid = 0 ORDER BY random() LIMIT ?`,
          STARTER_SETTLE_PER_TICK,
        )
        .toArray()) {
        const candidates = this.candidates(row);
        if (candidates && (await this.finishStored(row.token_hash, candidates, now)).done) {
          finished += 1;
        } else {
          open += 1;
        }
      }
      const result = await this.maintainLocked();
      if (finished + open === 0) return result;
      return {
        ...result,
        detail: `${result.detail}; ${finished} unresolved starter payout(s) settled, ${open} still open`,
      };
    });
  }
}

function starterChainFailure(result: PayoutResult): StarterRedeemResult {
  return {
    ok: false,
    code: "chain_unavailable",
    detail: "detail" in result ? result.detail : "broadcast failed",
  };
}

export class MainnetStarterTreasury extends StarterTreasury {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "mainnet");
  }
}

export class TestnetStarterTreasury extends StarterTreasury {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "testnet");
  }
}
