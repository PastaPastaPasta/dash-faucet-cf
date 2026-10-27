import { afterEach, describe, expect, it, vi } from "vitest";
import { AllProvidersFailedError, ChainClient } from "../src/chain";
import { classifyBroadcastError } from "../src/chain/types";
import { DapiProvider } from "../src/chain/dapi";
import { HyphenProvider } from "../src/chain/hyphen";
import { InsightProvider } from "../src/chain/insight";
import type { ProviderSpec } from "../src/config";
import { grpcOk, grpcStatus, grpcTrailers, lengthDelimited, varintField } from "./grpcweb";

const ADDR = "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs";
const SCRIPT = "76a9149290649ba520a35912dab1733b6f098587e432ef88ac";

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(route: Route) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
      route(String(input), init),
    ),
  );
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InsightProvider", () => {
  it("normalises rows and drops unconfirmed outputs", async () => {
    mockFetch(() =>
      ok([
        { txid: "aa", vout: 0, satoshis: 500, scriptPubKey: SCRIPT, height: 10, confirmations: 3 },
        { txid: "bb", vout: 1, amount: 0.000005, scriptPubKey: SCRIPT, confirmations: 0 },
      ]),
    );
    const utxos = await new InsightProvider("https://x").getUtxos(
      ADDR,
      AbortSignal.timeout(1000),
    );
    // The 0-conf row is ours-in-flight territory, owned by the Treasury ledger.
    expect(utxos).toEqual([
      { txid: "aa", outputIndex: 0, satoshis: 500, script: SCRIPT, height: 10 },
    ]);
  });

  it("converts a DASH `amount` to duffs when satoshis are absent", async () => {
    mockFetch(() =>
      ok([{ txid: "cc", vout: 0, amount: 1.5, scriptPubKey: SCRIPT, confirmations: 1 }]),
    );
    const utxos = await new InsightProvider("https://x").getUtxos(
      ADDR,
      AbortSignal.timeout(1000),
    );
    expect(utxos[0].satoshis).toBe(150_000_000);
  });
});

describe("HyphenProvider", () => {
  it("refuses a truncated UTXO set rather than under-reporting", async () => {
    // limit caps at 100 and offset is ignored, so there is no way to page.
    mockFetch(() => ok({ asOfHeight: 5, totalCount: 120, value: [] }));
    await expect(
      new HyphenProvider("https://h").getUtxos(ADDR, AbortSignal.timeout(1000)),
    ).rejects.toThrow(/truncated/);
  });

  it("treats a 404 as an empty address, not a provider failure", async () => {
    // hyphen answers "address not found" for an address with no history. That
    // means empty; failing over would make it look broken on a fresh faucet.
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "NotFound", message: "address not found" } }),
          { status: 404 },
        ),
    );
    await expect(
      new HyphenProvider("https://h").getUtxos(ADDR, AbortSignal.timeout(1000)),
    ).resolves.toEqual([]);
  });

  it("still fails over on a real server error", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    await expect(
      new HyphenProvider("https://h").getUtxos(ADDR, AbortSignal.timeout(1000)),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("never claims broadcast support", async () => {
    const p = new HyphenProvider("https://h");
    expect(p.canBroadcast).toBe(false);
    await expect(p.broadcast()).rejects.toThrow(/does not support broadcast/);
  });
});

const SPECS: ProviderSpec[] = [
  { kind: "hyphen", url: "https://h" },
  { kind: "insight", url: "https://i" },
  { kind: "dashrpc", url: "https://r" },
];

describe("outgoing requests", () => {
  it("always sends a User-Agent", async () => {
    // Workers' fetch sends none by default, and hyphen.dash.org answers such
    // requests with an HTTP 520 — which silently disabled the whole provider.
    const headers: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        headers.push(init.headers as Record<string, string> | undefined);
        return ok({ blockHeight: 1 });
      }),
    );

    await new HyphenProvider("https://h").getHeight(AbortSignal.timeout(1000));
    expect(headers[0]?.["User-Agent"]).toMatch(/dash-faucet/);
  });

  it("sends a User-Agent on JSON-RPC calls too", async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        headers.push(init.headers as Record<string, string> | undefined);
        return ok({ result: 5, error: null, id: 1 });
      }),
    );
    const { DashRpcProvider } = await import("../src/chain/dashrpc");
    await new DashRpcProvider("https://r").getHeight(AbortSignal.timeout(1000));
    expect(headers[0]?.["User-Agent"]).toMatch(/dash-faucet/);
  });
});

describe("DashRpcProvider ChainLocks", () => {
  it("reads the transaction's authoritative chainlock flag", async () => {
    mockFetch((_url, init) => {
      const request = JSON.parse(String(init.body));
      expect(request.method).toBe("getrawtransaction");
      return ok({
        result: { height: 123, confirmations: 2, chainlock: true },
        error: null,
        id: 1,
      });
    });
    const { DashRpcProvider } = await import("../src/chain/dashrpc");
    await expect(
      new DashRpcProvider("https://r").getChainLockStatus(
        "aa".repeat(32),
        AbortSignal.timeout(1000),
      ),
    ).resolves.toEqual({ known: true, height: 123, chainLocked: true });
  });
});

describe("ChainClient failover", () => {
  it("falls through to the next provider when one errors", async () => {
    mockFetch((url) => {
      if (url.includes("h/api/v1/status")) return ok({ blockHeight: 100 });
      if (url.includes("h/api/v1/address")) return new Response("boom", { status: 500 });
      if (url.includes("i/insight-api/status")) return ok({ info: { blocks: 100 } });
      if (url.includes("i/insight-api/addr"))
        return ok([
          { txid: "aa", vout: 0, satoshis: 7, scriptPubKey: SCRIPT, height: 99, confirmations: 1 },
        ]);
      return ok({ result: 100, error: null, id: 1 });
    });

    const snap = await new ChainClient(SPECS).getUtxos(ADDR);
    expect(snap.source).toBe("insight");
    expect(snap.utxos).toHaveLength(1);
    expect(snap.tipHeight).toBe(100);
  });

  it("skips a provider that lags the best-known tip", async () => {
    mockFetch((url) => {
      // Hyphen is 50 blocks behind: reading from it could hand us coins that
      // the rest of the network already knows are spent.
      if (url.includes("h/api/v1/status")) return ok({ blockHeight: 50 });
      if (url.includes("h/api/v1/address")) throw new Error("must not be called");
      if (url.includes("i/insight-api/status")) return ok({ info: { blocks: 100 } });
      if (url.includes("i/insight-api/addr")) return ok([]);
      return ok({ result: 100, error: null, id: 1 });
    });

    const snap = await new ChainClient(SPECS).getUtxos(ADDR);
    expect(snap.source).toBe("insight");
    expect(snap.statuses.find((s) => s.name === "hyphen")?.height).toBe(50);
  });

  it("throws when no provider answers at all", async () => {
    mockFetch(() => new Response("down", { status: 502 }));
    await expect(new ChainClient(SPECS).getUtxos(ADDR)).rejects.toBeInstanceOf(
      AllProvidersFailedError,
    );
  });
});

describe("classifyBroadcastError", () => {
  // The distinction that matters: a rejection proves the transaction is on no
  // mempool, so its inputs are safe to reuse. Silence proves nothing.
  it("classifies explicit protocol rejections as rejected", () => {
    for (const m of [
      "[insight] HTTP 400: bad-txns-inputs-missingorspent",
      "sendrawtransaction failed (-25): Missing inputs",
      "[insight] HTTP 400: dust",
      "TX decode failed",
      "min relay fee not met",
      "[dapi:seed-1] broadcastTransaction failed (grpc 3): invalid transaction: IO error",
      "[dapi:seed-1] broadcastTransaction failed (grpc 9): Transaction is rejected: insufficient fee",
    ]) {
      expect(classifyBroadcastError(m), m).toBe("rejected");
    }
  });

  it("classifies transport failures as ambiguous", () => {
    for (const m of [
      "The operation was aborted due to timeout",
      "signal timed out",
      "[dashrpc] HTTP 502: bad gateway",
      "[insight] HTTP 504: gateway timeout",
      "network connection lost",
      "fetch failed",
      "[dapi:seed-1] broadcastTransaction failed (grpc 14): unavailable",
      "[dapi:seed-1] broadcastTransaction failed (grpc 13): internal",
    ]) {
      expect(classifyBroadcastError(m), m).toBe("ambiguous");
    }
  });

  it("defaults unrecognised errors to ambiguous", () => {
    // Guessing "rejected" would release coins for a transaction that may be
    // live; guessing "ambiguous" only costs us liquidity.
    expect(classifyBroadcastError("something we have never seen")).toBe("ambiguous");
  });
});

describe("ChainClient broadcast", () => {
  it("succeeds when any single relay accepts", async () => {
    mockFetch((url) => {
      if (url.includes("i/insight-api/tx/send"))
        return new Response("nope", { status: 500 });
      return ok({ result: "deadbeef", error: null, id: 1 });
    });

    const res = await new ChainClient(SPECS).broadcast("00", "deadbeef");
    expect(res.accepted).toEqual(["dashrpc"]);
    expect(res.txid).toBe("deadbeef");
  });

  it("treats an already-known transaction as accepted", async () => {
    // A rebroadcast of something already in the mempool is a success.
    mockFetch((url) => {
      if (url.includes("i/insight-api/tx/send"))
        return new Response("transaction already in block chain", { status: 400 });
      return ok({
        result: null,
        error: { code: -27, message: "Transaction already in mempool" },
        id: 1,
      });
    });

    const res = await new ChainClient(SPECS).broadcast("00", "abc");
    expect(res.accepted.sort()).toEqual(["dashrpc", "insight"]);
  });

  it("reports outright rejection separately from silence", async () => {
    mockFetch(() => new Response("bad-txns-inputs-missingorspent", { status: 400 }));
    const res = await new ChainClient(SPECS).broadcast("00", "abc");
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(2);
    expect(res.ambiguous).toHaveLength(0);
  });

  it("reports a 5xx as ambiguous, not rejected", async () => {
    // The node may have accepted the transaction and failed to answer.
    mockFetch(() => new Response("upstream exploded", { status: 503 }));
    const res = await new ChainClient(SPECS).broadcast("00", "abc");
    expect(res.ambiguous).toHaveLength(2);
    expect(res.rejected).toHaveLength(0);
  });

  it("never asks a read-only provider to relay", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return ok({ result: "x", error: null, id: 1 });
    });
    await new ChainClient([{ kind: "hyphen", url: "https://h" }, SPECS[2]]).broadcast(
      "00",
      "x",
    );
    expect(seen.every((u) => !u.includes("//h"))).toBe(true);
  });
});

describe("ChainClient.anyKnowsTx", () => {
  const TX = "aa".repeat(32);

  it("returns true when any provider knows the transaction", async () => {
    mockFetch((url) => {
      if (url.includes("insight-api/tx/")) return ok({ txid: TX });
      return ok({ result: null, error: { code: -5, message: "No such mempool or blockchain transaction" }, id: 1 });
    });
    await expect(new ChainClient(SPECS).anyKnowsTx(TX)).resolves.toBe(true);
  });

  it("returns false only when a provider definitively answers no", async () => {
    mockFetch((url) => {
      if (url.includes("insight-api/tx/")) return new Response("nf", { status: 404 });
      if (url.includes("api/v1/tx/")) return new Response("nf", { status: 404 });
      return ok({ result: null, error: { code: -5, message: "No such mempool or blockchain transaction" }, id: 1 });
    });
    await expect(new ChainClient(SPECS).anyKnowsTx(TX)).resolves.toBe(false);
  });

  it("returns null when nobody could answer", async () => {
    // Must never be read as "absent" — that would release live coins.
    mockFetch(() => new Response("down", { status: 500 }));
    await expect(new ChainClient(SPECS).anyKnowsTx(TX)).resolves.toBeNull();
  });
});

describe("DapiProvider", () => {
  const TX = "ab".repeat(32);
  const dapi = () => new DapiProvider("https://seed-1.testnet.networks.dash.org:1443");
  const signal = () => AbortSignal.timeout(1000);

  it("is named after its seed and never lists UTXOs", async () => {
    const p = dapi();
    expect(p.name).toBe("dapi:seed-1");
    expect(p.canReadUtxos).toBe(false);
    await expect(p.getUtxos()).rejects.toThrow(/no address index/);
  });

  it("speaks grpc-web to the Core service and reads the height", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    mockFetch((url, init) => {
      seen = { url, init };
      return grpcOk(varintField(1, 1_580_503));
    });
    await expect(dapi().getHeight(signal())).resolves.toBe(1_580_503);
    expect(seen!.url).toBe(
      "https://seed-1.testnet.networks.dash.org:1443/org.dash.platform.dapi.v0.Core/getBestBlockHeight",
    );
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/grpc-web+proto");
    expect(headers["User-Agent"]).toMatch(/dash-faucet/);
    // An empty request is still one 5-byte grpc-web frame.
    expect([...(seen!.init.body as Uint8Array)]).toEqual([0, 0, 0, 0, 0]);
  });

  it("frames the raw transaction as field 1 and returns the node's txid", async () => {
    let body: Uint8Array | undefined;
    mockFetch((_url, init) => {
      body = init.body as Uint8Array;
      return grpcOk(lengthDelimited(1, new TextEncoder().encode(TX)));
    });
    await expect(dapi().broadcast("0102ff", signal())).resolves.toBe(TX);
    expect([...body!]).toEqual([0, 0, 0, 0, 5, 0x0a, 3, 0x01, 0x02, 0xff]);
  });

  it("skips fields it does not read, even fixed-width ones", async () => {
    // 2: fixed64, 3: fixed32 — neither is in today's response, both may come.
    const extra = [0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x1d, 1, 2, 3, 4];
    mockFetch(() => grpcOk([...extra, ...varintField(1, 42)]));
    await expect(dapi().getHeight(signal())).resolves.toBe(42);
  });

  it("surfaces Core's rejection text so the classifier can read it", async () => {
    mockFetch(() => grpcStatus(3, "invalid transaction: bad-txns-inputs-missingorspent"));
    const err = await dapi().broadcast("00", signal()).catch((e: Error) => e);
    expect(String(err)).toMatch(/grpc 3.*bad-txns-inputs-missingorspent/);
    expect(classifyBroadcastError(String(err))).toBe("rejected");
  });

  it("reads a status sent in the trailer frame, not just the headers", async () => {
    mockFetch(() =>
      grpcTrailers("grpc-status: 9\r\ngrpc-message: Transaction%20is%20rejected%3A%20dust\r\n"),
    );
    await expect(dapi().broadcast("00", signal())).rejects.toThrow(
      /grpc 9\): Transaction is rejected: dust/,
    );
  });

  it("keeps a grpc-message that is not valid percent-encoding as sent", async () => {
    mockFetch(() => grpcTrailers("grpc-status: 9\r\ngrpc-message: 100% rejected\r\n"));
    await expect(dapi().broadcast("00", signal())).rejects.toThrow(/grpc 9\): 100% rejected/);
  });

  it("never reads a reply without a grpc-status as success", async () => {
    mockFetch(
      () =>
        new Response(new Uint8Array([0, 0, 0, 0, 2, 0x0a, 0]), {
          status: 200,
          headers: { "content-type": "application/grpc-web+proto" },
        }),
    );
    const err = await dapi().broadcast("00", signal()).catch((e: Error) => e);
    expect(String(err)).toMatch(/no grpc-status/);
    expect(classifyBroadcastError(String(err))).toBe("ambiguous");
  });

  it("does not read an empty grpc-status as OK", async () => {
    mockFetch(() => grpcTrailers("grpc-status:\r\n"));
    await expect(dapi().broadcast("00", signal())).rejects.toThrow(/no grpc-status/);
  });

  it("refuses a 200 that is not grpc-web at all", async () => {
    mockFetch(() => new Response("<html>hello</html>", { status: 200 }));
    await expect(dapi().broadcast("00", signal())).rejects.toThrow(/non-grpc-web/);
  });

  it("refuses a truncated frame", async () => {
    mockFetch(
      () =>
        new Response(new Uint8Array([0, 0, 0, 0, 9, 0x08]), {
          status: 200,
          headers: { "content-type": "application/grpc-web+proto" },
        }),
    );
    await expect(dapi().getHeight(signal())).rejects.toThrow(/truncated grpc-web frame/);
  });

  it("treats a gateway 5xx as a transport failure", async () => {
    mockFetch(() => new Response("upstream", { status: 503 }));
    const err = await dapi().broadcast("00", signal()).catch((e: Error) => e);
    expect(classifyBroadcastError(String(err))).toBe("ambiguous");
  });

  it("reads NOT_FOUND as a definitive no, and anything else as unknown", async () => {
    mockFetch(() => grpcStatus(5, "Transaction not found"));
    await expect(dapi().hasTx(TX, signal())).resolves.toBe(false);
    mockFetch(() => grpcStatus(14, "unavailable"));
    await expect(dapi().hasTx(TX, signal())).rejects.toThrow(/grpc 14/);
  });

  it("reads ChainLock status from getTransaction", async () => {
    mockFetch(() =>
      grpcOk([...varintField(3, 1_580_000), ...varintField(4, 3), ...varintField(6, 1)]),
    );
    await expect(dapi().getChainLockStatus(TX, signal())).resolves.toEqual({
      known: true,
      height: 1_580_000,
      chainLocked: true,
    });
    // In the mempool DAPI omits height and confirmations altogether.
    mockFetch(() => grpcOk(lengthDelimited(1, new Uint8Array([1]))));
    await expect(dapi().getChainLockStatus(TX, signal())).resolves.toEqual({
      known: true,
      height: null,
      chainLocked: false,
    });
    mockFetch(() => grpcStatus(5, "Transaction not found"));
    await expect(dapi().getChainLockStatus(TX, signal())).resolves.toEqual({
      known: false,
      height: null,
      chainLocked: false,
    });
  });
});

describe("ChainClient with DAPI relays", () => {
  const TESTNET: ProviderSpec[] = [
    { kind: "insight", url: "https://i" },
    { kind: "dapi", url: "https://seed-1.d:1443" },
    { kind: "dapi", url: "https://seed-2.d:1443" },
  ];
  const coin = { txid: "aa", vout: 0, satoshis: 7, scriptPubKey: SCRIPT, height: 99, confirmations: 1 };

  /** DAPI tip, insight tip, and insight's UTXO listing. */
  function testnet(dapiHeight: number, insightHeight: number, listing: Route = () => ok([coin])): Route {
    return (url, init) => {
      if (url.includes("getBestBlockHeight")) return grpcOk(varintField(1, dapiHeight));
      if (url.includes("i/insight-api/status")) return ok({ info: { blocks: insightHeight } });
      if (url.includes("i/insight-api/addr")) return listing(url, init);
      throw new Error(`unexpected ${url}`);
    };
  }

  it("reads UTXOs from insight, using DAPI only for the tip", async () => {
    mockFetch(testnet(100, 100));
    const snap = await new ChainClient(TESTNET).getUtxos(ADDR);
    expect(snap.source).toBe("insight");
    expect(snap.statuses.map((s) => s.name)).toEqual(["insight", "dapi:seed-1", "dapi:seed-2"]);
  });

  it("refuses a lagging insight rather than reading stale coins", async () => {
    mockFetch(testnet(200, 150, () => {
      throw new Error("must not be called");
    }));
    await expect(new ChainClient(TESTNET).getUtxos(ADDR)).rejects.toThrow(
      /insight: 50 blocks behind tip/,
    );
  });

  it("gives the UTXO listing a longer deadline than the height survey", async () => {
    // Fake timers do not drive AbortSignal.timeout, so check the budgets where
    // they are set: three parallel height checks, then the listing.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mockFetch(testnet(100, 100));
    await new ChainClient(TESTNET).getUtxos(ADDR);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2500, 2500, 2500, 8000]);
  });

  it("retries a quickly failed UTXO listing once", async () => {
    let listings = 0;
    mockFetch(testnet(100, 100, () =>
      ++listings === 1 ? new Response("blip", { status: 502 }) : ok([coin]),
    ));
    const snap = await new ChainClient(TESTNET).getUtxos(ADDR);
    expect(listings).toBe(2);
    expect(snap.utxos).toHaveLength(1);
  });

  it("does not retry a listing that timed out", async () => {
    // Waiting out the deadline twice would only hold the Treasury longer.
    let listings = 0;
    // The deadline fires mid-body and surfaces as a plain AbortError: the
    // signal, not the error's name, is what says it was the deadline.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    mockFetch(testnet(100, 100, () => {
      listings++;
      throw new DOMException("The operation was aborted.", "AbortError");
    }));
    await expect(new ChainClient(TESTNET).getUtxos(ADDR)).rejects.toBeInstanceOf(
      AllProvidersFailedError,
    );
    expect(listings).toBe(1);
  });

  it("counts DAPI's ALREADY_EXISTS as an accepted rebroadcast", async () => {
    mockFetch((url) => {
      if (url.includes("i/insight-api/tx/send")) return new Response("boom", { status: 504 });
      return grpcStatus(6, "Transaction already in chain: transaction already in block chain");
    });
    const res = await new ChainClient(TESTNET).broadcast("00", "abc");
    expect(res.accepted).toEqual(["dapi:seed-1", "dapi:seed-2"]);
    expect(res.ambiguous).toHaveLength(1);
  });

  it("stays ambiguous when DAPI rejects but insight went silent", async () => {
    // The invariant the Treasury's input locking rests on: one relay's silence
    // outweighs any number of rejections, since that relay may have taken it.
    mockFetch((url) => {
      if (url.includes("i/insight-api/tx/send")) return new Response("timeout", { status: 504 });
      return grpcStatus(3, "invalid transaction: bad-txns-inputs-missingorspent");
    });
    const res = await new ChainClient(TESTNET).broadcast("00", "abc");
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(2);
    expect(res.ambiguous).toEqual([expect.stringMatching(/^insight: .*504/)]);
  });
});

describe("isCoinbase", () => {
  const TX = "cd".repeat(32);
  const signal = () => AbortSignal.timeout(1000);
  // version 3, type 5 (CbTx), one input spending the null outpoint.
  const COINBASE_RAW = [3, 0, 5, 0, 1, ...new Array(32).fill(0), 0xff, 0xff, 0xff, 0xff];
  const dapiTx = (bytes: number[]) => grpcOk(lengthDelimited(1, new Uint8Array(bytes)));

  it("reads insight's first input", async () => {
    const insight = new InsightProvider("https://i");
    mockFetch(() => ok({ txid: TX, vin: [{ coinbase: "03abcdef", n: 0 }] }));
    await expect(insight.isCoinbase(TX, signal())).resolves.toBe(true);
    mockFetch(() => ok({ txid: TX, vin: [{ txid: "aa", vout: 1 }] }));
    await expect(insight.isCoinbase(TX, signal())).resolves.toBe(false);
    // Unknown is not "no".
    mockFetch(() => new Response("Not found", { status: 404 }));
    await expect(insight.isCoinbase(TX, signal())).rejects.toThrow();
  });

  it("reads Core's verbose transaction", async () => {
    const { DashRpcProvider } = await import("../src/chain/dashrpc");
    mockFetch(() => ok({ result: { vin: [{ coinbase: "03ab" }] }, error: null, id: 1 }));
    await expect(new DashRpcProvider("https://r").isCoinbase(TX, signal())).resolves.toBe(true);
  });

  it("parses the raw transaction DAPI returns", async () => {
    const dapi = new DapiProvider("https://seed-1.d:1443");
    mockFetch(() => dapiTx([...COINBASE_RAW, 0x00]));
    await expect(dapi.isCoinbase(TX, signal())).resolves.toBe(true);

    mockFetch(() => dapiTx([2, 0, 0, 0, 1, ...new Array(32).fill(7), 0, 0, 0, 0, 0x00]));
    await expect(dapi.isCoinbase(TX, signal())).resolves.toBe(false);

    // Two inputs can never be a coinbase, whatever they spend.
    mockFetch(() => dapiTx([2, 0, 0, 0, 2]));
    await expect(dapi.isCoinbase(TX, signal())).resolves.toBe(false);

    mockFetch(() => grpcStatus(5, "Transaction not found"));
    await expect(dapi.isCoinbase(TX, signal())).rejects.toThrow(/unknown transaction/);
  });

  it("falls through to the next provider, and refuses to guess when none answers", async () => {
    const specs: ProviderSpec[] = [
      { kind: "insight", url: "https://i" },
      { kind: "dapi", url: "https://seed-1.d:1443" },
    ];
    mockFetch((url) =>
      url.includes("insight-api/tx/")
        ? new Response("down", { status: 503 })
        : dapiTx(COINBASE_RAW),
    );
    await expect(new ChainClient(specs).isCoinbase(TX)).resolves.toBe(true);

    mockFetch(() => new Response("down", { status: 503 }));
    await expect(new ChainClient(specs).isCoinbase(TX)).rejects.toBeInstanceOf(AllProvidersFailedError);
    await expect(
      new ChainClient([{ kind: "hyphen", url: "https://h" }]).isCoinbase(TX),
    ).rejects.toThrow(/no provider can look up transactions/);
  });
});
