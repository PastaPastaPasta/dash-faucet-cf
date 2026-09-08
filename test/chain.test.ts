import { afterEach, describe, expect, it, vi } from "vitest";
import { AllProvidersFailedError, ChainClient } from "../src/chain";
import { classifyBroadcastError } from "../src/chain/types";
import { HyphenProvider } from "../src/chain/hyphen";
import { InsightProvider } from "../src/chain/insight";
import type { ProviderSpec } from "../src/config";

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

afterEach(() => vi.unstubAllGlobals());

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
