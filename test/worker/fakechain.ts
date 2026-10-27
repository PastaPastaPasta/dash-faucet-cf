import DashKeys from "dashkeys";
import DashTx from "dashtx";
import { vi } from "vitest";
import { grpcOk, grpcStatus, lengthDelimited, lengthPrefix, varint } from "../grpcweb";

export interface Coin {
  txid: string;
  vout: number;
  satoshis: number;
}

/** One relay's broadcast attempt: which wire it came over, and the raw tx. */
export interface BroadcastAttempt {
  relay: "insight" | "dashrpc" | "dapi";
  hex: string;
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
  readonly broadcastAttempts: BroadcastAttempt[] = [];
  /**
   * Every token handed to Turnstile's siteverify. Recorded so a test can prove
   * that a proof-of-work capToken is never sent to Cloudflare.
   */
  readonly siteverifyTokens: string[] = [];
  siteverifySucceeds = true;
  siteverifyHostname = "faucet.test";
  siteverifyAction = "invitation_faucet";
  readonly platformIdentities = new Set<string>();
  /** When true, Platform Explorer answers every identity lookup with a 503. */
  platformDown = false;

  install(): void {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
      this.route(String(input), init),
    ));
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  private async scriptFor(address: string): Promise<string> {
    const version = address.startsWith("X") ? "mainnet" : "testnet";
    const parts = await DashKeys.decode(address, { version });
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
        hostname: this.siteverifyHostname,
        action: this.siteverifyAction,
        "error-codes": this.siteverifySucceeds ? [] : ["invalid-input-response"],
      });
    }

    // --- broadcast -----------------------------------------------------------
    if (url.includes("/insight-api/tx/send")) {
      const raw = String(JSON.parse(String(init.body)).rawtx);
      this.broadcastAttempts.push({ relay: "insight", hex: raw });
      if (this.broadcast.kind === "accept") {
        this.known.add(await DashTx.getId(raw));
      }
      return this.broadcastResponse(false);
    }
    if (url.includes("/org.dash.platform.dapi.v0.Core/")) {
      return this.dapi(url.split("/").pop()!, init);
    }
    if (url.includes("digitalcash") || url.endsWith("trpc") || url.includes("//r")) {
      const body = JSON.parse(String(init.body ?? "{}"));
      switch (body.method) {
        case "getblockcount":
          return this.json({ result: this.height, error: null, id: 1 });
        case "sendrawtransaction":
          this.broadcastAttempts.push({ relay: "dashrpc", hex: body.params[0] });
          if (this.broadcast.kind === "accept") {
            this.known.add(await DashTx.getId(body.params[0]));
          }
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
          if (this.knows(txid)) {
            return this.json({
              result: {
                txid,
                height: this.height - 5,
                confirmations: 6,
                chainlock: true,
              },
              error: null,
              id: 1,
            });
          }
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

    // --- Platform Explorer ---------------------------------------------------
    if (url.startsWith("https://platform.test/identity/")) {
      if (this.platformDown) return new Response("unavailable", { status: 503 });
      const id = decodeURIComponent(url.split("/identity/")[1]);
      return this.platformIdentities.has(id)
        ? this.json({ identifier: id })
        : this.json({ message: "not found" }, 404);
    }
    return new Response("unexpected request: " + url, { status: 500 });
  }

  /**
   * DAPI over grpc-web. Requests here carry at most one length-delimited
   * field 1, so the request decoder only needs to skip the tag and length.
   */
  private async dapi(method: string, init: RequestInit): Promise<Response> {
    const request = new Uint8Array(init.body as ArrayBuffer).subarray(5);
    const field1 = request.length === 0 ? new Uint8Array(0) : request.subarray(lengthPrefix(request));
    switch (method) {
      case "getBestBlockHeight":
        return grpcOk([0x08, ...varint(this.height)]);
      case "broadcastTransaction": {
        const hex = Array.from(field1, (b) => b.toString(16).padStart(2, "0")).join("");
        this.broadcastAttempts.push({ relay: "dapi", hex });
        switch (this.broadcast.kind) {
          case "accept": {
            const txid = await DashTx.getId(hex);
            this.known.add(txid);
            return grpcOk(lengthDelimited(1, new TextEncoder().encode(txid)));
          }
          case "reject":
            return grpcStatus(3, `invalid transaction: ${this.broadcast.message}`);
          case "silence":
          case "silent-but-live":
            return new Response("gateway timeout", { status: 504 });
        }
      }
      case "getTransaction": {
        const txid = new TextDecoder().decode(field1);
        if (!this.knows(txid)) return grpcStatus(5, "Transaction not found");
        // GetTransactionResponse: 3 height, 4 confirmations, 6 is_chain_locked.
        return grpcOk([
          0x18, ...varint(this.height - 5),
          0x20, ...varint(6),
          0x30, 1,
        ]);
      }
      default:
        return grpcStatus(12, `unimplemented: ${method}`);
    }
  }

  private knows(txid: string): boolean {
    if (this.broadcast.kind === "silent-but-live") return true;
    return this.known.has(txid);
  }
}
