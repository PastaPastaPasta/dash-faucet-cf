import { ProviderSpec } from "../config";
import { describeError } from "../errors";
import { DapiProvider } from "./dapi";
import { EvonodeDirectory } from "./evonodes";
import { socketFetch } from "./socket";
import { DashRpcProvider } from "./dashrpc";
import { HyphenProvider } from "./hyphen";
import { InsightProvider } from "./insight";
import {
  BroadcastFailure,
  ChainLockStatus,
  ChainProvider,
  Utxo,
  classifyBroadcastError,
  isAlreadyKnown,
} from "./types";

export type { Utxo } from "./types";

/** Per-request budget for a single provider call. */
const TIMEOUT_MS = 2500;
/**
 * A UTXO listing grows with the coin count (~240 KB for the testnet faucet's
 * ~870 coins); under the 2.5 s read budget its slow tail meant 503s.
 */
const UTXO_TIMEOUT_MS = 8000;
/**
 * Broadcasts get a longer budget than reads. A timeout here is *ambiguous* —
 * the node may have accepted the transaction and simply failed to answer — and
 * resolving that ambiguity is expensive, so it is worth waiting to avoid it.
 */
const BROADCAST_TIMEOUT_MS = 8000;
/** Core's verbose transaction lookup is slower than the lightweight reads. */
const CHAINLOCK_TIMEOUT_MS = 10_000;
/** A provider further behind the best tip than this is not trusted for reads. */
const MAX_LAG_BLOCKS = 10;
/** Evonodes asked per operation, drawn at random from the directory. */
const EVONODE_SAMPLE = 3;

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

function build(spec: Exclude<ProviderSpec, { kind: "evonodes" }>): ChainProvider {
  switch (spec.kind) {
    case "hyphen":
      return new HyphenProvider(spec.url);
    case "insight":
      return new InsightProvider(spec.url);
    case "dashrpc":
      return new DashRpcProvider(spec.url);
    case "dapi":
      return new DapiProvider(spec.url);
  }
}

/**
 * Fans reads across every configured explorer and fails over on error or
 * staleness. Broadcast goes to all relay-capable providers at once, which both
 * removes the single point of failure and improves propagation.
 */
export class ChainClient {
  /** Fixed providers asked on every operation. */
  private readonly primary: ChainProvider[] = [];
  /** Asked only when no primary DAPI source answered (the DCG seed gateways). */
  private readonly fallback: ChainProvider[] = [];
  private readonly evonodes?: {
    directory: EvonodeDirectory;
    transport: (url: string, init: RequestInit) => Promise<Response>;
    providers: Map<string, DapiProvider>;
  };

  constructor(specs: ProviderSpec[]) {
    for (const spec of specs) {
      if (spec.kind === "evonodes") {
        this.evonodes = {
          directory: new EvonodeDirectory(spec.network),
          transport: spec.transport === "fetch" ? (url, init) => fetch(url, init) : socketFetch,
          providers: new Map(),
        };
      } else {
        (spec.fallback ? this.fallback : this.primary).push(build(spec));
      }
    }
  }

  private signal(ms = TIMEOUT_MS): AbortSignal {
    return AbortSignal.timeout(ms);
  }

  /** The fixed primaries plus a fresh random sample of evonodes. */
  private async active(): Promise<ChainProvider[]> {
    if (!this.evonodes) return this.primary;
    const { directory, transport, providers } = this.evonodes;
    const sampled = (await directory.sample(EVONODE_SAMPLE)).map((origin) => {
      let provider = providers.get(origin);
      if (!provider) {
        provider = new DapiProvider(origin, transport);
        providers.set(origin, provider);
      }
      return provider;
    });
    return [...this.primary, ...sampled];
  }

  /** Bench an evonode that failed, so the next sample skips it for a while. */
  private bench(provider: ChainProvider): void {
    if (provider instanceof DapiProvider && this.evonodes?.providers.get(provider.origin) === provider) {
      this.evonodes.directory.bench(provider.origin);
    }
  }

  private static isDapi(provider: ChainProvider): boolean {
    return provider instanceof DapiProvider;
  }

  private async heights(providers: ChainProvider[]): Promise<ProviderStatus[]> {
    return Promise.all(
      providers.map(async (p): Promise<ProviderStatus> => {
        try {
          const height = await p.getHeight(this.signal());
          return { name: p.name, ok: true, height, error: null };
        } catch (err) {
          this.bench(p);
          return { name: p.name, ok: false, height: null, error: describeError(err) };
        }
      }),
    );
  }

  /**
   * Heights from the active providers, in parallel, plus the fallbacks when
   * no DAPI source among them answered. Never throws. `providers` is
   * index-aligned with `statuses`.
   */
  private async surveyWith(): Promise<{ providers: ChainProvider[]; statuses: ProviderStatus[] }> {
    const providers = await this.active();
    const statuses = await this.heights(providers);
    const dapiAnswered = providers.some((p, i) => ChainClient.isDapi(p) && statuses[i].ok);
    if (dapiAnswered || this.fallback.length === 0) return { providers, statuses };
    return {
      providers: [...providers, ...this.fallback],
      statuses: [...statuses, ...(await this.heights(this.fallback))],
    };
  }

  /** Heights from every provider asked. Never throws. */
  async survey(): Promise<ProviderStatus[]> {
    return (await this.surveyWith()).statuses;
  }

  /**
   * Confirmed UTXOs for `address`, from the first healthy provider that is not
   * lagging the best-known tip. Refusing to read from a stale provider is what
   * stops us from spending coins that another provider already knows are gone.
   */
  async getUtxos(address: string): Promise<UtxoSnapshot> {
    const { providers, statuses } = await this.surveyWith();
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
    const eligible: ChainProvider[] = [];
    // statuses is index-aligned with providers. Matching by name instead would
    // collapse two providers of the same kind.
    for (const [i, provider] of providers.entries()) {
      if (!provider.canReadUtxos) continue;
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
      eligible.push(provider);
    }

    // A quick failure (a 5xx blip) earns that provider one more try, once,
    // which matters most where it is the only UTXO source. A timeout does not:
    // asking again would only double the wait while the Treasury is held.
    let retried = false;
    for (let i = 0; i < eligible.length; i++) {
      const signal = this.signal(UTXO_TIMEOUT_MS);
      try {
        const utxos = await eligible[i].getUtxos(address, signal);
        return { utxos, source: eligible[i].name, tipHeight, statuses };
      } catch (err) {
        errors.push(describeError(err));
        // Ask the signal, not the error: a deadline that fires mid-body can
        // surface under a different error name than one that fires in fetch.
        if (!retried && !signal.aborted) {
          retried = true;
          i--;
        }
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
    const relays = (await this.active()).filter((p) => p.canBroadcast);
    if (relays.length === 0 && this.fallback.length === 0) {
      throw new Error("no broadcast-capable providers configured");
    }

    const result: BroadcastResult = {
      txid: expectedTxid,
      accepted: [],
      rejected: [],
      ambiguous: [],
    };
    await this.relay(relays, rawHex, result);
    // Same bytes, same txid: asking the seeds as well can never double-pay,
    // so they get it whenever no primary relay took it.
    if (result.accepted.length === 0) {
      await this.relay(this.fallback.filter((p) => p.canBroadcast), rawHex, result);
    }
    return result;
  }

  private async relay(
    relays: ChainProvider[],
    rawHex: string,
    result: BroadcastResult,
  ): Promise<void> {
    const settled = await Promise.allSettled(
      relays.map((p) => p.broadcast(rawHex, this.signal(BROADCAST_TIMEOUT_MS))),
    );

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
      if (kind !== "rejected") this.bench(relays[i]);
      (kind === "rejected" ? result.rejected : result.ambiguous).push(
        `${name}: ${message}`,
      );
    }
  }

  /**
   * Ask every provider whether it knows a transaction.
   *
   * Returns true if any does, false if at least one answered "no" and none said
   * yes, and null when nobody could answer — the caller must treat null as
   * "still unknown", never as "absent".
   */
  async anyKnowsTx(txid: string): Promise<boolean | null> {
    const first = await this.knowsTx(await this.active(), txid);
    if (first !== null || this.fallback.length === 0) return first;
    return this.knowsTx(this.fallback, txid);
  }

  private async knowsTx(providers: ChainProvider[], txid: string): Promise<boolean | null> {
    const settled = await Promise.allSettled(
      providers.map((p) => p.hasTx(txid, this.signal())),
    );
    let answered = false;
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") continue;
      if (outcome.value) return true;
      answered = true;
    }
    return answered ? false : null;
  }

  /** Coinbase or not, from the first provider that can answer. */
  async isCoinbase(txid: string): Promise<boolean> {
    const capable = [...(await this.active()), ...this.fallback].filter(
      (provider) => provider.isCoinbase,
    );
    const errors: string[] = [];
    for (const provider of capable) {
      try {
        return await provider.isCoinbase!(txid, this.signal());
      } catch (err) {
        errors.push(describeError(err));
      }
    }
    throw new AllProvidersFailedError(
      "isCoinbase",
      errors.length > 0 ? errors : ["no provider can look up transactions"],
    );
  }

  /** ChainLock status from the first Core RPC provider that can answer. */
  async getChainLockStatus(txid: string): Promise<ChainLockStatus> {
    const capable = [...(await this.active()), ...this.fallback].filter(
      (provider) => provider.getChainLockStatus,
    );
    const errors: string[] = [];
    for (const provider of capable) {
      try {
        return await provider.getChainLockStatus!(
          txid,
          this.signal(CHAINLOCK_TIMEOUT_MS),
        );
      } catch (err) {
        errors.push(describeError(err));
      }
    }
    throw new AllProvidersFailedError(
      "getChainLockStatus",
      errors.length > 0 ? errors : ["no Core RPC provider configured"],
    );
  }
}
