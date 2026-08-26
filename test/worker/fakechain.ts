import DashKeys from "dashkeys";
import { vi } from "vitest";

export interface Coin {
  txid: string;
  vout: number;
  satoshis: number;
}

export type BroadcastBehaviour =
  | { kind: "accept" }
  | { kind: "reject"; message: string }
  /** Node accepted it but never answered — the dangerous ambiguous case. */
  | { kind: "silence" }
  /** Silent, and the transaction really is live on the network. */
  | { kind: "silent-but-live" };

/**
 * A stand-in for the block explorers, installed over `globalThis.fetch`.
 *
 * Tests and worker code share an isolate under vitest-pool-workers, so stubbing
 * fetch here also intercepts the Durable Object's outbound calls.
 */
export class FakeChain {
  height = 100;
  coins: Coin[] = [];
  broadcast: BroadcastBehaviour = { kind: "accept" };
  /** Transactions the network will admit to knowing. */
  readonly known = new Set<string>();
  readonly broadcastAttempts: string[] = [];
  /**
   * Every token handed to Turnstile's siteverify. Recorded so a test can prove
   * that a proof-of-work capToken is never sent to Cloudflare.
   */
  readonly siteverifyTokens: string[] = [];
  siteverifySucceeds = true;

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
      this.route(String(input), init),
    ));
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  private async scriptFor(address: string): Promise<string> {
    const parts = await DashKeys.decode(address, { version: "testnet" });
    return `76a914${parts.pubKeyHash}88ac`;
  }

  private broadcastResponse(rpc: boolean): Response {
    switch (this.broadcast.kind) {
      case "accept":
        return rpc
          ? this.json({ result: "ok", error: null, id: 1 })
          : this.json({ txid: "ok" });
      case "reject":
        return rpc
          ? this.json({ result: null, error: { code: -25, message: this.broadcast.message }, id: 1 })
          : new Response(this.broadcast.message, { status: 400 });
      case "silence":
      case "silent-but-live":
        // A gateway timeout: indistinguishable, from our side, from a node
        // that accepted the transaction and failed to reply.
        return new Response("gateway timeout", { status: 504 });
    }
  }

  private async route(url: string, init: RequestInit): Promise<Response> {
    // --- captcha -------------------------------------------------------------
    if (url.includes("challenges.cloudflare.com/turnstile")) {
      const form = init.body as FormData;
      this.siteverifyTokens.push(String(form.get("response") ?? ""));
      return this.json({
        success: this.siteverifySucceeds,
        "error-codes": this.siteverifySucceeds ? [] : ["invalid-input-response"],
      });
    }

    // --- broadcast -----------------------------------------------------------
    if (url.includes("/insight-api/tx/send")) {
      this.broadcastAttempts.push(String(init.body));
      return this.broadcastResponse(false);
    }
    if (url.includes("digitalcash") || url.endsWith("trpc") || url.includes("//r")) {
      const body = JSON.parse(String(init.body ?? "{}"));
      switch (body.method) {
        case "getblockcount":
          return this.json({ result: this.height, error: null, id: 1 });
        case "sendrawtransaction":
          this.broadcastAttempts.push(String(init.body));
          return this.broadcastResponse(true);
        case "getaddressutxos": {
          const address = body.params[0].addresses[0];
          const script = await this.scriptFor(address);
          return this.json({
            result: this.coins.map((c) => ({
              txid: c.txid,
              outputIndex: c.vout,
              script,
              satoshis: c.satoshis,
              height: this.height - 5,
            })),
            error: null,
            id: 1,
          });
        }
        case "getrawtransaction": {
          const txid = body.params[0];
          if (this.knows(txid)) return this.json({ result: { txid }, error: null, id: 1 });
          return this.json({
            result: null,
            error: { code: -5, message: "No such mempool or blockchain transaction" },
            id: 1,
          });
        }
        default:
          return this.json({ result: null, error: { code: -32601, message: "no" }, id: 1 });
      }
    }

    // --- insight reads -------------------------------------------------------
    if (url.includes("/insight-api/status")) {
      return this.json({ info: { blocks: this.height } });
    }
    if (url.includes("/insight-api/addr/")) {
      const address = url.split("/insight-api/addr/")[1].split("/")[0];
      const script = await this.scriptFor(address);
      return this.json(
        this.coins.map((c) => ({
          txid: c.txid,
          vout: c.vout,
          satoshis: c.satoshis,
          scriptPubKey: script,
          height: this.height - 5,
          confirmations: 6,
        })),
      );
    }
    if (url.includes("/insight-api/tx/")) {
      const txid = url.split("/insight-api/tx/")[1];
      return this.knows(txid)
        ? this.json({ txid })
        : new Response("not found", { status: 404 });
    }

    return new Response("unexpected request: " + url, { status: 500 });
  }

  private knows(txid: string): boolean {
    if (this.broadcast.kind === "silent-but-live") return true;
    return this.known.has(txid);
  }
}
