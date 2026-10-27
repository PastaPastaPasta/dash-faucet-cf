import { ChainLockStatus, ChainProvider, ProviderError, USER_AGENT, Utxo } from "./types";

const SERVICE = "org.dash.platform.dapi.v0.Core";

/** Raised for a non-OK grpc status, carrying the status code. */
class GrpcError extends ProviderError {
  constructor(
    provider: string,
    readonly code: number,
    message: string,
  ) {
    super(provider, message);
  }
}

/**
 * Dash Platform DAPI Core over grpc-web — the gateway every evonode runs.
 *
 * Only hostnames work here: Workers refuse to fetch a bare IP (Cloudflare error
 * 1003), and evonodes are addressed by IP with IP-only certificates. That
 * leaves the DCG-run `seed-N.<network>.networks.dash.org` gateways, which do
 * have hostname certificates and serve DAPI on :1443.
 *
 * DAPI has no address index, so this provider cannot list UTXOs. It is a
 * height source, a relay, and a transaction lookup.
 *
 * Messages are hand-encoded from the field numbers in `@dashevo/dapi-grpc`
 * `protos/core/v0/core.proto`; the four calls used need nothing more.
 *
 * Broadcast errors keep Core's own text. Both DAPI implementations (js-dapi
 * and rs-dapi) answer a Core rejection with INVALID_ARGUMENT or
 * FAILED_PRECONDITION and a connection problem with UNAVAILABLE, which is
 * what `classifyBroadcastError` relies on.
 */
export class DapiProvider implements ChainProvider {
  readonly name: string;
  readonly canBroadcast = true;
  readonly canReadUtxos = false;

  constructor(private readonly origin: string) {
    this.name = `dapi:${new URL(origin).hostname.split(".")[0]}`;
  }

  private async call(
    method: string,
    request: Uint8Array,
    signal: AbortSignal,
  ): Promise<Fields> {
    const res = await fetch(`${this.origin}/${SERVICE}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "User-Agent": USER_AGENT,
      },
      body: frame(request),
      signal,
    });
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
      throw new ProviderError(this.name, `HTTP ${res.status} for ${method}`);
    }
    // Anything else answering 200 — a captive page, a misrouted proxy — must
    // not be parsed as frames and read as success.
    if (!(res.headers.get("content-type") ?? "").startsWith("application/grpc-web")) {
      throw new ProviderError(this.name, `non-grpc-web response for ${method}`);
    }

    let message: Uint8Array | null = null;
    const trailers: string[] = [];
    for (let i = 0; i < body.length; ) {
      if (i + 5 > body.length) throw new ProviderError(this.name, "truncated grpc-web frame");
      const length = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0);
      const end = i + 5 + length;
      if (end > body.length) throw new ProviderError(this.name, "truncated grpc-web frame");
      const payload = body.subarray(i + 5, end);
      if (body[i] & 0x80) trailers.push(new TextDecoder().decode(payload));
      else message ??= payload;
      i = end;
    }

    // A "trailers-only" reply carries the status in the HTTP headers instead.
    // No status at all is a broken reply, not success.
    const block = trailers.join("\r\n");
    const status = header(block, "grpc-status") ?? res.headers.get("grpc-status");
    if (status === null || !/^\d+$/.test(status)) {
      throw new ProviderError(this.name, `${method} returned no grpc-status`);
    }
    const code = Number(status);
    if (code !== 0) {
      const raw = header(block, "grpc-message") ?? res.headers.get("grpc-message") ?? "";
      let text = raw;
      try {
        text = decodeURIComponent(raw);
      } catch {
        // Not percent-encoded after all: keep it as sent.
      }
      throw new GrpcError(this.name, code, `${method} failed (grpc ${code}): ${text}`);
    }
    if (message === null) {
      throw new ProviderError(this.name, `${method} returned no message`);
    }
    return decode(message);
  }

  async getHeight(signal: AbortSignal): Promise<number> {
    const fields = await this.call("getBestBlockHeight", new Uint8Array(0), signal);
    const height = fields.get(1);
    if (typeof height !== "number" || height === 0) {
      throw new ProviderError(this.name, "getBestBlockHeight returned no height");
    }
    return height;
  }

  async getUtxos(): Promise<Utxo[]> {
    throw new ProviderError(this.name, "DAPI has no address index");
  }

  /** getTransaction, or null when DAPI definitively does not know the txid. */
  private async lookup(txid: string, signal: AbortSignal): Promise<Fields | null> {
    try {
      return await this.call("getTransaction", field(1, txid), signal);
    } catch (err) {
      // NOT_FOUND (5) is DAPI's rendering of Core's -5: a definitive no.
      // Anything else is a provider problem and must not be read as "absent".
      if (err instanceof GrpcError && err.code === 5) return null;
      throw err;
    }
  }

  async hasTx(txid: string, signal: AbortSignal): Promise<boolean> {
    return (await this.lookup(txid, signal)) !== null;
  }

  async broadcast(rawHex: string, signal: AbortSignal): Promise<string> {
    const fields = await this.call(
      "broadcastTransaction",
      field(1, hexToBytes(rawHex)),
      signal,
    );
    const txid = fields.get(1);
    if (!(txid instanceof Uint8Array) || txid.length === 0) {
      throw new ProviderError(this.name, "broadcastTransaction returned no txid");
    }
    return new TextDecoder().decode(txid);
  }

  async getChainLockStatus(txid: string, signal: AbortSignal): Promise<ChainLockStatus> {
    const fields = await this.lookup(txid, signal);
    if (fields === null) return { known: false, height: null, chainLocked: false };
    // GetTransactionResponse: 3 height, 4 confirmations, 6 is_chain_locked.
    // DAPI omits the height entirely while the transaction is in the mempool.
    const height = fields.get(3);
    const confirmations = fields.get(4);
    if (typeof height !== "number" || typeof confirmations !== "number") {
      return { known: true, height: null, chainLocked: false };
    }
    return { known: true, height, chainLocked: fields.get(6) === 1 };
  }
}

/** First value of each field: varints as numbers, length-delimited as bytes. */
type Fields = Map<number, number | Uint8Array>;

function frame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length);
  out.set(message, 5);
  return out;
}

/** One length-delimited protobuf field. Every request here is a single one. */
function field(number: number, value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Uint8Array.from([...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]);
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

function decode(buf: Uint8Array): Fields {
  const fields: Fields = new Map();
  let i = 0;
  const readVarint = (): number => {
    let result = 0;
    let scale = 1;
    let byte: number;
    do {
      if (i >= buf.length) throw new Error("truncated protobuf varint");
      byte = buf[i++];
      result += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return result;
  };
  while (i < buf.length) {
    const key = readVarint();
    const number = Math.floor(key / 8);
    let value: number | Uint8Array;
    switch (key % 8) {
      case 0:
        value = readVarint();
        break;
      case 2: {
        const length = readVarint();
        if (i + length > buf.length) throw new Error("truncated protobuf field");
        value = buf.subarray(i, i + length);
        i += length;
        break;
      }
      // fixed64 / fixed32: none of the fields read here, so skip them rather
      // than fail a reply over a field added later.
      case 1:
        i += 8;
        continue;
      case 5:
        i += 4;
        continue;
      default:
        throw new Error(`unsupported protobuf wire type ${key % 8}`);
    }
    if (!fields.has(number)) fields.set(number, value);
  }
  return fields;
}

function header(block: string, name: string): string | null {
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
