import { ChainProvider, ProviderError, USER_AGENT, Utxo } from "./types";

interface RpcResponse<T> {
  result: T | null;
  error: { code: number; message: string } | null;
  id: number;
}

/** Raised for an RPC-level error, carrying the node's own error code. */
class RpcError extends ProviderError {
  constructor(
    provider: string,
    readonly code: number,
    message: string,
  ) {
    super(provider, message);
  }
}

/**
 * Public unauthenticated Dash Core JSON-RPC (digitalcash.dev). Reads come from
 * the address index; it can also relay. No wallet is loaded on these nodes,
 * which is exactly what we want — they are a read/relay surface, nothing more.
 */
export class DashRpcProvider implements ChainProvider {
  readonly name = "dashrpc";
  readonly canBroadcast = true;

  constructor(private readonly origin: string) {}

  /**
   * Deliberately does not route through `fetchJson`. That helper throws on a
   * non-2xx status *before* parsing, but these nodes return RPC-level errors as
   * HTTP 500 with a meaningful JSON `error.message`. Going through fetchJson
   * would turn "-27 Transaction already in mempool" into an opaque
   * "HTTP 500: {...}" and degrade every other RPC error message with it.
   */
  private async call<T>(
    method: string,
    params: unknown[],
    signal: AbortSignal,
  ): Promise<T> {
    const res = await fetch(this.origin, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
    const text = await res.text();
    let body: RpcResponse<T>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError(
        this.name,
        `non-JSON response for ${method}: ${text.slice(0, 200)}`,
      );
    }
    if (body.error) {
      throw new RpcError(
        this.name,
        body.error.code,
        `${method} failed (${body.error.code}): ${body.error.message}`,
      );
    }
    if (body.result === null || body.result === undefined) {
      throw new ProviderError(this.name, `${method} returned no result`);
    }
    return body.result;
  }

  async getHeight(signal: AbortSignal): Promise<number> {
    return this.call<number>("getblockcount", [], signal);
  }

  async getUtxos(address: string, signal: AbortSignal): Promise<Utxo[]> {
    const rows = await this.call<
      Array<{
        txid: string;
        outputIndex: number;
        script: string;
        satoshis: number;
        height: number;
      }>
    >("getaddressutxos", [{ addresses: [address] }], signal);

    return rows.map((u) => ({
      txid: u.txid,
      outputIndex: u.outputIndex,
      satoshis: u.satoshis,
      script: u.script,
      height: u.height ?? null,
    }));
  }

  async hasTx(txid: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.call<unknown>("getrawtransaction", [txid, 1], signal);
      return true;
    } catch (err) {
      // -5 is "No such mempool or blockchain transaction" — a definitive no.
      // Anything else is a provider problem and must not be read as "absent".
      if (err instanceof RpcError && err.code === -5) return false;
      throw err;
    }
  }

  async broadcast(rawHex: string, signal: AbortSignal): Promise<string> {
    return this.call<string>("sendrawtransaction", [rawHex], signal);
  }
}
