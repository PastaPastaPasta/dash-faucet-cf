import { COIN } from "../config";
import { ChainProvider, ProviderError, Utxo, fetchJson, headExists } from "./types";

interface InsightUtxo {
  txid: string;
  vout: number;
  satoshis?: number;
  amount?: number;
  scriptPubKey: string;
  height?: number;
  confirmations?: number;
}

/** Bitcore Insight API. Available on both networks, and can broadcast. */
export class InsightProvider implements ChainProvider {
  readonly name = "insight";
  readonly canBroadcast = true;

  constructor(private readonly origin: string) {}

  async getHeight(signal: AbortSignal): Promise<number> {
    const body = (await fetchJson(
      this.name,
      `${this.origin}/insight-api/status`,
      signal,
    )) as { info?: { blocks?: number } };
    const blocks = body.info?.blocks;
    if (typeof blocks !== "number") {
      throw new ProviderError(this.name, "status response had no info.blocks");
    }
    return blocks;
  }

  async getUtxos(address: string, signal: AbortSignal): Promise<Utxo[]> {
    const rows = (await fetchJson(
      this.name,
      `${this.origin}/insight-api/addr/${address}/utxo`,
      signal,
    )) as InsightUtxo[];
    if (!Array.isArray(rows)) {
      throw new ProviderError(this.name, "utxo response was not an array");
    }

    return rows
      // Insight includes 0-conf outputs. In-flight change is tracked by the
      // Treasury instead, so provider rows are restricted to confirmed coins
      // to keep the two sources from disagreeing.
      .filter((u) => (u.confirmations ?? 0) >= 1)
      .map((u) => ({
        txid: u.txid,
        outputIndex: u.vout,
        satoshis: u.satoshis ?? Math.round((u.amount ?? 0) * COIN),
        script: u.scriptPubKey,
        height: u.height ?? null,
      }));
  }

  async hasTx(txid: string, signal: AbortSignal): Promise<boolean> {
    return headExists(this.name, `${this.origin}/insight-api/tx/${txid}`, signal);
  }

  async broadcast(rawHex: string, signal: AbortSignal): Promise<string> {
    const body = (await fetchJson(
      this.name,
      `${this.origin}/insight-api/tx/send`,
      signal,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawtx: rawHex }),
      },
    )) as { txid?: string };
    if (!body.txid) {
      throw new ProviderError(this.name, "send response had no txid");
    }
    return body.txid;
  }
}
