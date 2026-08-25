import { ChainProvider, ProviderError, Utxo, fetchJson, headExists } from "./types";

interface HyphenUtxoResponse {
  asOfHeight: number;
  totalCount: number;
  value: Array<{
    txHash: string;
    vout: number;
    value: number;
    height: number;
    scriptPubKey: string;
  }>;
}

/**
 * Dash's own explorer API. Mainnet only — there is no testnet deployment.
 *
 * Read-only by design: it exposes no broadcast route. `/api/v1/tx/broadcast`
 * looks like one but is really `/api/v1/tx/{txid}`, and POST is rejected by
 * nginx with a 405.
 */
export class HyphenProvider implements ChainProvider {
  readonly name = "hyphen";
  readonly canBroadcast = false;

  constructor(private readonly origin: string) {}

  async getHeight(signal: AbortSignal): Promise<number> {
    const body = (await fetchJson(
      this.name,
      `${this.origin}/api/v1/status`,
      signal,
    )) as { blockHeight?: number };
    if (typeof body.blockHeight !== "number") {
      throw new ProviderError(this.name, "status response had no blockHeight");
    }
    return body.blockHeight;
  }

  async getUtxos(address: string, signal: AbortSignal): Promise<Utxo[]> {
    // `limit` maxes out at 100 and `offset` is silently ignored, so there is no
    // way to page. A truncated view is treated as a failure rather than
    // silently under-reporting the balance.
    //
    // An address with no history 404s with "address not found". That means the
    // address is empty, not that the provider is down — treating it as an error
    // would make hyphen look broken on a faucet that has not been funded yet.
    const body = (await fetchJson(
      this.name,
      `${this.origin}/api/v1/address/${address}/utxos?limit=100`,
      signal,
      {},
      { asOfHeight: 0, totalCount: 0, value: [] },
    )) as HyphenUtxoResponse;

    const rows = body.value ?? [];
    if (typeof body.totalCount === "number" && body.totalCount > rows.length) {
      throw new ProviderError(
        this.name,
        `truncated utxo set (${rows.length} of ${body.totalCount}); cannot page`,
      );
    }

    return rows.map((u) => ({
      txid: u.txHash,
      outputIndex: u.vout,
      satoshis: u.value,
      script: u.scriptPubKey,
      height: u.height ?? null,
    }));
  }

  async hasTx(txid: string, signal: AbortSignal): Promise<boolean> {
    return headExists(this.name, `${this.origin}/api/v1/tx/${txid}`, signal);
  }

  async broadcast(): Promise<string> {
    throw new ProviderError(this.name, "provider does not support broadcast");
  }
}
