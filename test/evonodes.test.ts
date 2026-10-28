import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainClient } from "../src/chain";
import {
  BOOTSTRAP,
  EvonodeDirectory,
  evonodeOrigin,
  parseExplorer,
  parseQuorumService,
} from "../src/chain/evonodes";
import { readResponse } from "../src/chain/socket";
import type { ProviderSpec } from "../src/config";
import { grpcOk, grpcStatus, lengthDelimited, varintField } from "./grpcweb";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      return handler(url);
    }),
  );
  return calls;
}

const quorumList = (addresses: string[]) => ({
  success: true,
  data: [
    ...addresses.map((a) => ({
      status: "ENABLED",
      versionCheck: "success",
      addresses: { platform_https: [a] },
    })),
    { status: "POSE_BANNED", versionCheck: "fail", addresses: { platform_https: ["9.9.9.9:1443"] } },
    { status: "ENABLED", versionCheck: "fail", addresses: { platform_https: ["8.8.8.8:1443"] } },
    { status: "ENABLED", versionCheck: "success", address: "[::]:0", addresses: {} },
  ],
});

describe("evonode list sources", () => {
  it("keeps only enabled, version-checked masternodes from the quorum service", () => {
    expect(parseQuorumService(quorumList(["1.2.3.4:1443"]))).toEqual(["1.2.3.4:1443"]);
    expect(() => parseQuorumService({ success: false })).toThrow();
  });

  it("keeps only active, unbanned validators from Platform Explorer", () => {
    const row = (isActive: boolean, ban: number, a: string) => ({
      isActive,
      proTxInfo: { state: { PoSeBanHeight: ban, addresses: { platform_https: [a] } } },
    });
    expect(
      parseExplorer({ resultSet: [row(true, -1, "1.1.1.1:443"), row(false, -1, "2.2.2.2:443"), row(true, 5, "3.3.3.3:443")] }),
    ).toEqual(["1.1.1.1:443"]);
  });

  it("accepts only public IPv4 host:port", () => {
    expect(evonodeOrigin("68.67.122.12:1443")).toBe("https://68.67.122.12:1443");
    for (const bad of ["[::]:0", "0.0.0.0:0", "10.0.0.1:1443", "192.168.1.1:443", "172.20.0.1:443", "1.2.3.256:443", "1.2.3.4", "host:443", "1.2.3.4:70000"]) {
      expect(evonodeOrigin(bad)).toBeNull();
    }
  });

  it("ships a usable bootstrap list for both networks", () => {
    for (const network of ["testnet", "mainnet"] as const) {
      expect(BOOTSTRAP[network].length).toBeGreaterThanOrEqual(20);
      expect(BOOTSTRAP[network].every((a) => evonodeOrigin(a) !== null)).toBe(true);
    }
  });
});

describe("EvonodeDirectory", () => {
  const listed = Array.from({ length: 12 }, (_, i) => `1.0.0.${i + 1}:1443`);
  const origins = listed.map((a) => `https://${a}`);

  it("serves the snapshot at once, then the quorum service's list, and caches it", async () => {
    const calls = stubFetch(() => Response.json(quorumList(listed)));
    const dir = new EvonodeDirectory("testnet");
    // Never waits for discovery: the first sample is the compiled-in snapshot.
    const first = dir.sample(3);
    expect(BOOTSTRAP.testnet.map((a) => `https://${a}`)).toEqual(expect.arrayContaining(first));
    await dir.refresh();
    expect(dir.listSource).toBe("quorums");
    const sample = dir.sample(3);
    expect(sample).toHaveLength(3);
    for (const origin of sample) expect(origins).toContain(origin);
    dir.sample(3);
    await dir.refresh();
    expect(calls).toHaveLength(1);
  });

  it("falls back to Platform Explorer, then keeps the compiled-in snapshot", async () => {
    stubFetch((url) =>
      url.includes("quorums")
        ? new Response("down", { status: 503 })
        : Response.json({
            resultSet: listed.map((a) => ({
              isActive: true,
              proTxInfo: { state: { PoSeBanHeight: -1, addresses: { platform_https: [a] } } },
            })),
          }),
    );
    const viaExplorer = new EvonodeDirectory("testnet");
    await viaExplorer.refresh();
    expect(viaExplorer.listSource).toBe("explorer");

    stubFetch(() => new Response("down", { status: 503 }));
    const viaSnapshot = new EvonodeDirectory("testnet");
    await viaSnapshot.refresh();
    expect(viaSnapshot.listSource).toBe("bootstrap");
    expect(BOOTSTRAP.testnet.map((a) => `https://${a}`)).toContain(viaSnapshot.sample(1)[0]);
  });

  it("refuses a list too short to trust", async () => {
    stubFetch(() => Response.json(quorumList(listed.slice(0, 9))));
    const dir = new EvonodeDirectory("testnet");
    await dir.refresh();
    expect(dir.listSource).toBe("bootstrap");
  });

  it("skips benched nodes until the bench expires", async () => {
    let now = 1_000_000;
    stubFetch(() => Response.json(quorumList(listed)));
    const dir = new EvonodeDirectory("testnet", () => now);
    await dir.refresh();
    const [first] = dir.sample(1);
    dir.bench(first);
    for (let i = 0; i < 30; i++) expect(dir.sample(12)).not.toContain(first);
    now += 11 * 60_000;
    expect(dir.sample(12)).toContain(first);
  });
});

describe("ChainClient with evonodes", () => {
  const specs: ProviderSpec[] = [
    { kind: "insight", url: "https://insight.test" },
    { kind: "evonodes", network: "testnet", transport: "fetch" },
    { kind: "dapi", url: "https://seed-1.test:1443", fallback: true },
  ];
  const isEvonode = (url: string) => /^https:\/\/\d+\.\d+\.\d+\.\d+:/.test(url);
  const grpcTxid = (txid: string) => grpcOk(lengthDelimited(1, new TextEncoder().encode(txid)));
  const notFound = () => grpcStatus(5, "Transaction not found");
  const TXID = "ab".repeat(32);

  /** Every endpoint the client may touch; `evonode` and `seed` answer DAPI calls. */
  function network(opts: {
    insightHeight?: number;
    insight?: (url: string) => Response;
    evonode: (method: string, url: string) => Response;
    seed?: (method: string) => Response;
  }) {
    return stubFetch((url) => {
      if (url.includes("quorums") || url.includes("explorer")) return new Response("down", { status: 503 });
      if (url.includes("insight.test")) {
        if (opts.insight) return opts.insight(url);
        return Response.json({ info: { blocks: opts.insightHeight ?? 1000 } });
      }
      const method = url.split("/").pop()!;
      if (url.includes("seed-1")) return (opts.seed ?? (() => new Response("down", { status: 503 })))(method);
      return opts.evonode(method, url);
    });
  }

  it("never asks the seeds while an evonode answers", async () => {
    const calls = network({ evonode: () => grpcOk(varintField(1, 1000)) });
    const statuses = await new ChainClient(specs).survey();
    expect(calls.some((u) => u.includes("seed-1"))).toBe(false);
    expect(statuses.filter((s) => s.name.startsWith("dapi:") && s.ok)).toHaveLength(3);
  });

  it("asks the seeds when no evonode answers", async () => {
    const calls = network({
      evonode: () => new Response("down", { status: 503 }),
      seed: () => grpcOk(varintField(1, 1000)),
    });
    const statuses = await new ChainClient(specs).survey();
    expect(calls.some((u) => u.includes("seed-1"))).toBe(true);
    expect(statuses.find((s) => s.name === "dapi:seed-1")?.ok).toBe(true);
  });

  it("does not let one evonode's wild height make insight look stale", async () => {
    let first = true;
    network({
      insight: (url) =>
        url.includes("/utxo") ? Response.json([]) : Response.json({ info: { blocks: 1000 } }),
      evonode: () => {
        const height = first ? 9_000_000 : 1000;
        first = false;
        return grpcOk(varintField(1, height));
      },
    });
    const snapshot = await new ChainClient(specs).getUtxos("yAddr");
    expect(snapshot.source).toBe("insight");
    expect(snapshot.tipHeight).toBe(1000);
  });

  it("treats acceptance by evonodes alone as ambiguous, never as success", async () => {
    network({
      insight: () => new Response("down", { status: 503 }),
      evonode: () => grpcTxid(TXID),
    });
    const result = await new ChainClient(specs).broadcast("00", TXID);
    expect(result.accepted).toEqual([]);
    expect(result.ambiguous.some((a) => a.includes("unvouched"))).toBe(true);
  });

  it("counts evonode acceptance alongside a configured relay's", async () => {
    network({
      insight: () => Response.json({ txid: TXID }),
      evonode: () => grpcTxid(TXID),
    });
    const result = await new ChainClient(specs).broadcast("00", TXID);
    expect(result.accepted).toHaveLength(4);
  });

  it("does not count an evonode answering with another txid", async () => {
    network({
      insight: () => Response.json({ txid: TXID }),
      evonode: () => grpcTxid("cd".repeat(32)),
    });
    const result = await new ChainClient(specs).broadcast("00", TXID);
    expect(result.accepted).toEqual(["insight"]);
    expect(result.ambiguous).toHaveLength(3);
  });

  it("ignores an evonode's lone claim to know a transaction", async () => {
    network({
      insight: () => new Response("down", { status: 503 }),
      evonode: () =>
        grpcOk([...varintField(3, 990), ...varintField(4, 6), ...varintField(6, 1)]),
      seed: () => notFound(),
    });
    expect(await new ChainClient(specs).anyKnowsTx(TXID)).toBe(false);
  });

  it("never takes ChainLock status from a sampled evonode", async () => {
    const calls = network({
      evonode: () => grpcOk([...varintField(3, 990), ...varintField(4, 6), ...varintField(6, 1)]),
      seed: () => notFound(),
    });
    const status = await new ChainClient(specs).getChainLockStatus(TXID);
    expect(status.known).toBe(false);
    expect(calls.filter(isEvonode)).toHaveLength(0);
  });
});

describe("HTTP/1 response parsing", () => {
  const stream = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });

  it("reads a Content-Length body split across reads", async () => {
    const res = await readResponse(stream("HTTP/1.1 200 OK\r\nContent-Type: application/grpc-web+proto\r\nContent-Le", "ngth: 5\r\n\r\nhel", "lo"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/grpc-web+proto");
    expect(await res.text()).toBe("hello");
  });

  it("decodes a chunked body", async () => {
    const res = await readResponse(stream("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nhel\r\n2;x=y\r\nlo\r\n0\r\n\r\n"));
    expect(await res.text()).toBe("hello");
    expect(res.headers.has("transfer-encoding")).toBe(false);
  });

  it("reads to the end of the connection without a length", async () => {
    const res = await readResponse(stream("HTTP/1.0 503 Service Unavailable\r\n\r\ndown"));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("down");
  });

  it("rejects truncated and malformed responses", async () => {
    await expect(readResponse(stream("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort"))).rejects.toThrow(/truncated/);
    await expect(readResponse(stream("HTTP/1.1 200 OK\r\n"))).rejects.toThrow(/truncated/);
    await expect(readResponse(stream("SPDY/3 200 OK\r\n\r\n"))).rejects.toThrow(/malformed/);
    await expect(readResponse(stream("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"))).rejects.toThrow(/chunk/);
  });
});
