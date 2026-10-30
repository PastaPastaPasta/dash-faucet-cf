/**
 * People who signed in, and redemption codes, stored in the Treasury's SQLite.
 *
 * Everything here is synchronous SQL with no `await`, so the Durable Object's
 * single thread makes each call atomic without the spending lock — except code
 * redemption, which the Treasury runs inside its payout lock so a code's cap
 * and the payout it allows are decided together.
 */

export type CodeKind = "event" | "voucher";

/** A signed-in person: `google:<sub>` or `github:<numeric id>`. */
export interface Identity {
  id: string;
  provider: "google" | "github";
  email: string;
  name: string;
  /** GitHub login, for display. */
  login?: string;
}

export interface CodeInfo {
  id: string;
  code: string;
  kind: CodeKind;
  label: string;
  amountSats: number;
  maxRedemptions: number;
  redemptions: number;
  expiresAt: number | null;
  disabled: boolean;
  batch: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CodeRow {
  [key: string]: string | number | null;
  id: string;
  code: string;
  code_key: string;
  kind: string;
  label: string;
  amount_sats: number;
  max_redemptions: number;
  redemptions: number;
  expires_at: number | null;
  disabled: number;
  batch: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Redemption {
  address: string;
  txid: string;
  satoshis: number;
  createdAt: number;
}

export function migrateAccounts(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT    PRIMARY KEY,
      provider      TEXT    NOT NULL,
      email         TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      login         TEXT,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codes (
      id              TEXT    PRIMARY KEY,
      code            TEXT    NOT NULL,
      code_key        TEXT    NOT NULL UNIQUE,
      kind            TEXT    NOT NULL,
      label           TEXT    NOT NULL,
      amount_sats     INTEGER NOT NULL,
      max_redemptions INTEGER NOT NULL,
      redemptions     INTEGER NOT NULL DEFAULT 0,
      expires_at      INTEGER,
      disabled        INTEGER NOT NULL DEFAULT 0,
      batch           TEXT,
      created_by      TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    -- Audit log as well as the per-address and per-network check; never pruned.
    CREATE TABLE IF NOT EXISTS code_redemptions (
      code_id    TEXT    NOT NULL,
      address    TEXT    NOT NULL,
      ip         TEXT    NOT NULL,
      txid       TEXT    NOT NULL,
      satoshis   INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS code_redemptions_address ON code_redemptions (code_id, address);
    CREATE INDEX IF NOT EXISTS code_redemptions_ip ON code_redemptions (code_id, ip);
  `);

  const keyColumns = new Set(
    sql
      .exec<{ name: string }>(`PRAGMA table_info(api_keys)`)
      .toArray()
      .map((row) => row.name),
  );
  // Keys minted before login existed have no owner and never expire.
  if (!keyColumns.has("owner")) sql.exec(`ALTER TABLE api_keys ADD COLUMN owner TEXT`);
  if (!keyColumns.has("expires_at")) sql.exec(`ALTER TABLE api_keys ADD COLUMN expires_at INTEGER`);
  sql.exec(`CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys (owner)`);
}

export function upsertUser(sql: SqlStorage, who: Identity, now: number): void {
  sql.exec(
    `INSERT INTO users (id, provider, email, name, login, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
       login = excluded.login, last_login_at = excluded.last_login_at`,
    who.id,
    who.provider,
    who.email,
    who.name,
    who.login ?? null,
    now,
    now,
  );
}

// --- codes -------------------------------------------------------------------

/** What a code is matched on: case, spaces and dashes never matter. */
export function codeKey(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A typeable event code: letters, digits and dashes, 4–32 characters. */
export function isEventCode(display: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{2,30}[A-Z0-9]$/.test(display) && codeKey(display).length >= 4;
}

/** Crockford base32: no I, L, O or U to misread. */
const VOUCHER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `XXXX-XXXX-XXXX`: 60 random bits, far past guessing at captcha speed. */
export function generateVoucherCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => VOUCHER_ALPHABET[b & 31]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function codeInfo(row: CodeRow): CodeInfo {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind as CodeKind,
    label: row.label,
    amountSats: row.amount_sats,
    maxRedemptions: row.max_redemptions,
    redemptions: row.redemptions,
    expiresAt: row.expires_at,
    disabled: row.disabled !== 0,
    batch: row.batch,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewCodes {
  kind: CodeKind;
  /** Display forms, already validated. */
  codes: string[];
  label: string;
  amountSats: number;
  maxRedemptions: number;
  expiresAt: number | null;
  createdBy: string;
}

/** Inserts every code or none; reports the first one that already exists. */
export function createCodes(
  sql: SqlStorage,
  input: NewCodes,
  now: number,
): { ok: true; codes: CodeInfo[] } | { ok: false; conflict: string } {
  for (const code of input.codes) {
    const taken = sql
      .exec(`SELECT 1 FROM codes WHERE code_key = ?`, codeKey(code))
      .toArray();
    if (taken.length > 0) return { ok: false, conflict: code };
  }
  const batch = input.codes.length > 1 ? randomId() : null;
  const ids: string[] = [];
  for (const code of input.codes) {
    const id = randomId();
    ids.push(id);
    sql.exec(
      `INSERT INTO codes (id, code, code_key, kind, label, amount_sats, max_redemptions,
         expires_at, batch, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      code,
      codeKey(code),
      input.kind,
      input.label,
      input.amountSats,
      input.maxRedemptions,
      input.expiresAt,
      batch,
      input.createdBy,
      now,
      now,
    );
  }
  return { ok: true, codes: ids.map((id) => getCode(sql, id)!) };
}

export function getCode(sql: SqlStorage, id: string): CodeInfo | null {
  const row = sql.exec<CodeRow>(`SELECT * FROM codes WHERE id = ?`, id).toArray()[0];
  return row ? codeInfo(row) : null;
}

export function listCodes(sql: SqlStorage): CodeInfo[] {
  return sql
    .exec<CodeRow>(`SELECT * FROM codes ORDER BY created_at DESC, code`)
    .toArray()
    .map(codeInfo);
}

export function listRedemptions(sql: SqlStorage, codeId: string): Redemption[] {
  return sql
    .exec<{ address: string; txid: string; satoshis: number; created_at: number }>(
      `SELECT address, txid, satoshis, created_at FROM code_redemptions
        WHERE code_id = ? ORDER BY created_at DESC LIMIT 500`,
      codeId,
    )
    .toArray()
    .map((r) => ({ address: r.address, txid: r.txid, satoshis: r.satoshis, createdAt: r.created_at }));
}

export interface CodePatch {
  label?: string;
  amountSats?: number;
  maxRedemptions?: number;
  expiresAt?: number | null;
  disabled?: boolean;
}

export function updateCode(
  sql: SqlStorage,
  id: string,
  patch: CodePatch,
  now: number,
): CodeInfo | null {
  const current = getCode(sql, id);
  if (!current) return null;
  sql.exec(
    `UPDATE codes SET label = ?, amount_sats = ?, max_redemptions = ?, expires_at = ?,
       disabled = ?, updated_at = ? WHERE id = ?`,
    patch.label ?? current.label,
    patch.amountSats ?? current.amountSats,
    patch.maxRedemptions ?? current.maxRedemptions,
    patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
    (patch.disabled ?? current.disabled) ? 1 : 0,
    now,
    id,
  );
  return getCode(sql, id);
}

export type CodeCheck =
  | { ok: true; code: CodeRow }
  | { ok: false; reason: "invalid" | "used" };

/**
 * Whether `key` may pay `address` from `ip` right now. Unknown, disabled,
 * expired and fully redeemed codes are deliberately indistinguishable, so the
 * endpoint is no oracle for which codes exist.
 */
export function checkCode(
  sql: SqlStorage,
  key: string,
  address: string,
  ip: string,
  now: number,
): CodeCheck {
  const row = sql.exec<CodeRow>(`SELECT * FROM codes WHERE code_key = ?`, key).toArray()[0];
  if (
    !row ||
    row.disabled !== 0 ||
    (row.expires_at !== null && row.expires_at <= now) ||
    row.redemptions >= row.max_redemptions
  ) {
    return { ok: false, reason: "invalid" };
  }
  const prior = sql
    .exec(
      `SELECT 1 FROM code_redemptions WHERE code_id = ? AND (address = ? OR ip = ?) LIMIT 1`,
      row.id,
      address,
      ip,
    )
    .toArray();
  return prior.length > 0 ? { ok: false, reason: "used" } : { ok: true, code: row };
}

export function recordRedemption(
  sql: SqlStorage,
  code: CodeRow,
  address: string,
  ip: string,
  txid: string,
  satoshis: number,
  now: number,
): void {
  sql.exec(
    `INSERT INTO code_redemptions (code_id, address, ip, txid, satoshis, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    code.id,
    address,
    ip,
    txid,
    satoshis,
    now,
  );
  sql.exec(`UPDATE codes SET redemptions = redemptions + 1 WHERE id = ?`, code.id);
}
