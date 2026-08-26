/** Normalised chain types shared by every provider. */

export interface Utxo {
  txid: string;
  outputIndex: number;
  satoshis: number;
  /** Locking script, hex. */
  script: string;
  /** Block height, or null when unknown/unconfirmed. */
  height: number | null;
}

export interface ChainProvider {
  readonly name: string;
  readonly canBroadcast: boolean;
  getHeight(signal: AbortSignal): Promise<number>;
  /** Confirmed UTXOs only. In-flight outputs are tracked by the Treasury. */
  getUtxos(address: string, signal: AbortSignal): Promise<Utxo[]>;
  /** Whether this provider knows the transaction, in a block or the mempool. */
  hasTx(txid: string, signal: AbortSignal): Promise<boolean>;
  broadcast(rawHex: string, signal: AbortSignal): Promise<string>;
  /** Optional Core-specific ChainLock lookup used by pre-created invitations. */
  getChainLockStatus?(
    txid: string,
    signal: AbortSignal,
  ): Promise<ChainLockStatus>;
}

export interface ChainLockStatus {
  known: boolean;
  height: number | null;
  chainLocked: boolean;
}

/**
 * Workers' fetch sends no User-Agent by default, and hyphen.dash.org answers
 * such requests with an HTTP 520. Identifying ourselves is also just good
 * manners toward explorer operators.
 */
export const USER_AGENT =
  "dash-faucet/1.0 (+https://github.com/PastaPastaPasta/dash-faucet)";

/**
 * Substrings, all lowercase, each tested with `includes`. Every node phrases
 * this differently and all of them mean "your transaction is fine, stop
 * asking" — a rebroadcast of something already in the mempool is a success.
 */
const ALREADY_KNOWN = [
  "already in block chain",
  "already in the mempool",
  "already known",
  "txn-already-known",
  "txn-already-in-mempool",
  "-27",
];

export function isAlreadyKnown(message: string): boolean {
  const m = message.toLowerCase();
  return ALREADY_KNOWN.some((needle) => m.includes(needle));
}

/**
 * A node that explicitly rejected the transaction has definitely not put it in
 * its mempool, so the inputs are safe to reuse. Anything else — a timeout, a
 * dropped connection, a 5xx — is *ambiguous*: the node may have accepted the
 * transaction and simply failed to tell us.
 */
const REJECTED_PATTERNS = [
  /bad-txns/,
  /missing inputs/,
  /inputs-missingorspent/,
  /mandatory-script-verify/,
  /non-mandatory-script-verify/,
  /min relay fee/,
  /absurdly-high-fee/,
  /dust/,
  /tx decode failed/,
  /txn-mempool-conflict/,
  /-2[2-6]\b/,
];

export type BroadcastFailure = "rejected" | "ambiguous";

export function classifyBroadcastError(message: string): BroadcastFailure {
  const m = message.toLowerCase();
  // Transport-level failures first: a 5xx body could contain anything.
  if (
    /timeout|timed out|aborted|abort|network|socket|econn|fetch failed|http 5\d\d/.test(
      m,
    )
  ) {
    return "ambiguous";
  }
  if (REJECTED_PATTERNS.some((re) => re.test(m))) return "rejected";
  // Default to the cautious reading: assume it might be on the network.
  return "ambiguous";
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

export async function fetchJson(
  provider: string,
  url: string,
  signal: AbortSignal,
  init: RequestInit = {},
  /** Returned instead of throwing on a 404, where 404 means "empty". */
  notFoundValue?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  if (res.status === 404 && notFoundValue !== undefined) return notFoundValue;
  if (!res.ok) {
    throw new ProviderError(provider, `HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(provider, `non-JSON response: ${text.slice(0, 200)}`);
  }
}

/** True if the URL responds 2xx, false on 404, throwing on anything else. */
export async function headExists(
  provider: string,
  url: string,
  signal: AbortSignal,
): Promise<boolean> {
  const res = await fetch(url, {
    signal,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new ProviderError(provider, `HTTP ${res.status}`);
  }
  return true;
}
