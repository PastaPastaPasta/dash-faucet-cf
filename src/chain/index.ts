import { ProviderSpec } from "../config";
import { describeError } from "../errors";
import { DashRpcProvider } from "./dashrpc";
import { HyphenProvider } from "./hyphen";
import { InsightProvider } from "./insight";
import {
  BroadcastFailure,
  ChainProvider,
  Utxo,
  classifyBroadcastError,
  isAlreadyKnown,
} from "./types";

export type { Utxo } from "./types";

/** Per-request budget for a single provider call. */
const TIMEOUT_MS = 2500;
/**
 * Broadcasts get a longer budget than reads. A timeout here is *ambiguous* —
 * the node may have accepted the transaction and simply failed to answer — and
 * resolving that ambiguity is expensive, so it is worth waiting to avoid it.
 */
const BROADCAST_TIMEOUT_MS = 8000;
/** A provider further behind the best tip than this is not trusted for reads. */
const MAX_LAG_BLOCKS = 10;

export interface ProviderStatus {
  name: string;
  ok: boolean;
  height: number | null;
  error: string | null;
}

export interface UtxoSnapshot {
  utxos: Utxo[];
  /** Provider the UTXO set came from. */
  source: string;
  /** Best height seen across all providers. */
  tipHeight: number;
  statuses: ProviderStatus[];
}

export interface BroadcastResult {
  txid: string;
  /** Providers that accepted, or reported the transaction as already known. */
  accepted: string[];
  /** Providers that definitively rejected it: the transaction is not theirs. */
  rejected: string[];
  /** Providers whose outcome is unknown — timeout, 5xx, dropped connection. */
  ambiguous: string[];
}

export class AllProvidersFailedError extends Error {
  constructor(
    readonly operation: string,
    readonly errors: string[],
  ) {
    super(`all providers failed for ${operation}: ${errors.join(" | ")}`);
    this.name = "AllProvidersFailedError";
  }
}

function build(spec: ProviderSpec): ChainProvider {
  switch (spec.kind) {
    case "hyphen":
      return new HyphenProvider(spec.url);
    case "insight":
      return new InsightProvider(spec.url);
    case "dashrpc":
      return new DashRpcProvider(spec.url);
  }
}

/**
 * Fans reads across every configured explorer and fails over on error or
 * staleness. Broadcast goes to all relay-capable providers at once, which both
 * removes the single point of failure and improves propagation.
 */
export class ChainClient {
  private readonly providers: ChainProvider[];

  constructor(specs: ProviderSpec[]) {
    this.providers = specs.map(build);
  }

  private signal(ms = TIMEOUT_MS): AbortSignal {
    return AbortSignal.timeout(ms);
  }

  /** Heights from every provider, in parallel. Never throws. */
  async survey(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.providers.map(async (p): Promise<ProviderStatus> => {
        try {
          const height = await p.getHeight(this.signal());
          return { name: p.name, ok: true, height, error: null };
        } catch (err) {
          return { name: p.name, ok: false, height: null, error: describeError(err) };
        }
      }),
    );
  }

  /**
   * Confirmed UTXOs for `address`, from the first healthy provider that is not
   * lagging the best-known tip. Refusing to read from a stale provider is what
   * stops us from spending coins that another provider already knows are gone.
   */
  async getUtxos(address: string): Promise<UtxoSnapshot> {
    const statuses = await this.survey();
    const heights = statuses
      .map((s) => s.height)
      .filter((h): h is number => h !== null);

    if (heights.length === 0) {
      throw new AllProvidersFailedError(
        "getHeight",
        statuses.map((s) => s.error ?? "unknown"),
      );
    }
    const tipHeight = Math.max(...heights);

    const errors: string[] = [];
    // survey() maps over this.providers, so statuses is index-aligned with it.
    // Matching by name instead would collapse two providers of the same kind.
    for (const [i, provider] of this.providers.entries()) {
      const status = statuses[i];
      if (!status.ok || status.height === null) {
        errors.push(`${provider.name}: unreachable`);
        continue;
      }
      const lag = tipHeight - status.height;
      if (lag > MAX_LAG_BLOCKS) {
        errors.push(`${provider.name}: ${lag} blocks behind tip`);
        continue;
      }
      try {
        const utxos = await provider.getUtxos(address, this.signal());
        return { utxos, source: provider.name, tipHeight, statuses };
      } catch (err) {
        errors.push(describeError(err));
      }
    }

    throw new AllProvidersFailedError("getUtxos", errors);
  }

  /**
   * Broadcast to every relay-capable provider at once. Never throws: the caller
   * needs the accepted/rejected/ambiguous split to decide whether the inputs
   * are safe to reuse.
   */
  async broadcast(rawHex: string, expectedTxid: string): Promise<BroadcastResult> {
    const relays = this.providers.filter((p) => p.canBroadcast);
    if (relays.length === 0) {
      throw new Error("no broadcast-capable providers configured");
    }

    const settled = await Promise.allSettled(
      relays.map((p) => p.broadcast(rawHex, this.signal(BROADCAST_TIMEOUT_MS))),
    );

    const result: BroadcastResult = {
      txid: expectedTxid,
      accepted: [],
      rejected: [],
      ambiguous: [],
    };

    for (const [i, outcome] of settled.entries()) {
      const name = relays[i].name;
      if (outcome.status === "fulfilled") {
        result.accepted.push(name);
        continue;
      }
      const message = describeError(outcome.reason);
      if (isAlreadyKnown(message)) {
        result.accepted.push(name);
        continue;
      }
      const kind: BroadcastFailure = classifyBroadcastError(message);
      (kind === "rejected" ? result.rejected : result.ambiguous).push(
        `${name}: ${message}`,
      );
    }

    return result;
  }

  /**
   * Ask every provider whether it knows a transaction.
   *
   * Returns true if any does, false if at least one answered "no" and none said
   * yes, and null when nobody could answer — the caller must treat null as
   * "still unknown", never as "absent".
   */
  async anyKnowsTx(txid: string): Promise<boolean | null> {
    const settled = await Promise.allSettled(
      this.providers.map((p) => p.hasTx(txid, this.signal())),
    );
    let answered = false;
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") continue;
      if (outcome.value) return true;
      answered = true;
    }
    return answered ? false : null;
  }
}
