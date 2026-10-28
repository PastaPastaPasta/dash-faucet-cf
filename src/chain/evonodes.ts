/**
 * Where the faucet finds evonodes to talk DAPI to.
 *
 * Evonodes are reached by IP over `cloudflare:sockets` (see `socket.ts`), so
 * the faucet does not depend on the DCG-run `seed-N` gateways — those are
 * only the last fallback, in `ChainClient`. The list itself comes from, in
 * order:
 *
 * 1. the quorum service's `/masternodes` (every masternode with its
 *    `platform_https` address, status and a version check),
 * 2. Platform Explorer's active validator list (independently operated),
 * 3. a snapshot compiled in below, so a cold isolate with both lists down
 *    still has nodes to try. Stale entries cost one failed connection each
 *    before they are benched.
 *
 * The directory is per isolate and in memory: refreshing it is one small GET,
 * and a lost list is rebuilt on the next request.
 */
import type { NetworkName } from "../config";
import { describeError } from "../errors";
import { USER_AGENT } from "./types";

/** Re-read the lists this often. Masternode sets change over days, not minutes. */
const REFRESH_MS = 60 * 60_000;
/** Retry discovery sooner after it failed, so a blip does not pin the snapshot for an hour. */
const RETRY_MS = 5 * 60_000;
/** A node that failed a call is skipped for this long. */
const BENCH_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_MS = 4000;
/** Fewer than this from a source is a broken or hostile list, not a network. */
const MIN_LISTED = 10;

const SOURCES: Record<NetworkName, { quorums: string; explorer: string }> = {
  testnet: {
    quorums: "https://quorums.testnet.networks.dash.org/masternodes",
    explorer: "https://testnet.platform-explorer.pshenmic.dev/validators?limit=100&isActive=true",
  },
  mainnet: {
    quorums: "https://quorums.mainnet.networks.dash.org/masternodes",
    explorer: "https://platform-explorer.pshenmic.dev/validators?limit=100&isActive=true",
  },
};

/** Healthy `platform_https` addresses from the quorum service, 2026-10-28. */
export const BOOTSTRAP: Record<NetworkName, string[]> = {
  testnet: [
    "206.245.167.63:1443", "68.67.122.10:1443", "68.67.122.11:1443",
    "68.67.122.12:1443", "68.67.122.13:1443", "68.67.122.14:1443",
    "68.67.122.15:1443", "68.67.122.16:1443", "68.67.122.17:1443",
    "68.67.122.18:1443", "68.67.122.19:1443", "68.67.122.1:1443",
    "68.67.122.20:1443", "68.67.122.21:1443", "68.67.122.23:1443",
    "68.67.122.24:1443", "68.67.122.25:1443", "68.67.122.26:1443",
    "68.67.122.27:1443", "68.67.122.28:1443", "68.67.122.29:1443",
    "68.67.122.2:1443", "68.67.122.3:1443", "68.67.122.4:1443",
    "68.67.122.5:1443", "68.67.122.6:1443", "68.67.122.7:1443",
    "68.67.122.8:1443", "68.67.122.9:1443", "85.209.243.10:1443",
    "85.209.243.1:1443", "85.209.243.2:1443", "85.209.243.3:1443",
    "85.209.243.4:1443", "85.209.243.5:1443", "85.209.243.6:1443",
    "85.209.243.7:1443", "85.209.243.8:1443", "85.209.243.9:1443",
    "87.229.22.126:1443",
  ],
  mainnet: [
    "109.199.105.14:443", "109.199.108.234:443", "109.199.109.39:443",
    "109.199.124.135:443", "109.199.124.30:443", "130.162.233.186:443",
    "130.185.118.3:443", "132.243.197.250:443", "132.243.197.252:443",
    "132.243.197.38:443", "139.84.236.208:443", "144.91.121.81:443",
    "15.235.102.215:443", "161.97.159.172:443", "161.97.173.67:443",
    "161.97.180.182:443", "161.97.85.159:443", "178.18.254.136:443",
    "207.180.213.141:443", "213.199.54.171:443", "31.220.91.60:443",
    "34.210.238.67:443", "37.27.83.17:443", "44.240.99.214:443",
    "46.62.250.247:443", "5.161.103.48:443", "5.189.151.7:443",
    "5.199.166.218:443", "5.78.73.117:443", "51.68.3.29:443",
    "62.171.168.4:443", "62.171.171.253:443", "64.176.10.71:443",
    "84.32.22.199:443", "84.32.22.20:443", "85.190.243.3:443",
    "88.216.191.115:443", "89.35.131.39:443", "93.115.172.38:443",
    "95.111.232.18:443",
  ],
};

const IPV4_PORT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;

/** `https://ip:port` for a public IPv4 `ip:port`, or null for anything else. */
export function evonodeOrigin(address: string): string | null {
  const m = IPV4_PORT.exec(address);
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const port = Number(m[5]);
  if (octets.some((o) => o > 255) || port < 1 || port > 65535) return null;
  return isPublicIpv4(octets) ? `https://${address}` : null;
}

/** False for placeholder, private, shared, link-local, documentation, benchmark and multicast space. */
function isPublicIpv4([a, b, c]: number[]): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

interface QuorumServiceEntry {
  status?: string;
  versionCheck?: string;
  addresses?: { platform_https?: string[] };
}

interface ExplorerValidator {
  isActive?: boolean;
  proTxInfo?: { state?: { PoSeBanHeight?: number; addresses?: { platform_https?: string[] } } };
}

export function parseQuorumService(body: unknown): string[] {
  const data = (body as { data?: QuorumServiceEntry[] })?.data;
  if (!Array.isArray(data)) throw new Error("quorum service: no data array");
  return data
    .filter((m) => m.status === "ENABLED" && m.versionCheck === "success")
    .flatMap((m) => m.addresses?.platform_https ?? []);
}

export function parseExplorer(body: unknown): string[] {
  const rows = (body as { resultSet?: ExplorerValidator[] })?.resultSet;
  if (!Array.isArray(rows)) throw new Error("platform explorer: no resultSet");
  return rows
    .filter((v) => v.isActive && (v.proTxInfo?.state?.PoSeBanHeight ?? -1) === -1)
    .flatMap((v) => v.proTxInfo?.state?.addresses?.platform_https ?? []);
}

function origins(addresses: string[]): string[] {
  return [...new Set(addresses.map(evonodeOrigin).filter((o): o is string => o !== null))];
}

export class EvonodeDirectory {
  private nodes: string[];
  private source = "bootstrap";
  private nextRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private readonly benched = new Map<string, number>();

  constructor(
    private readonly network: NetworkName,
    private readonly now: () => number = Date.now,
  ) {
    this.nodes = origins(BOOTSTRAP[network]);
  }

  /** Where the current list came from: `quorums`, `explorer` or `bootstrap`. */
  get listSource(): string {
    return this.source;
  }

  /**
   * Up to `n` distinct evonode origins, at random, skipping benched ones.
   *
   * Never waits for discovery: callers hold the Treasury lock, and an idle
   * Durable Object is evicted often enough that waiting would put a discovery
   * round on most payouts. The current list (the snapshot, on a cold isolate)
   * is served while a refresh runs in the background.
   */
  sample(n: number): string[] {
    void this.refresh();
    const now = this.now();
    const live = this.nodes.filter((o) => (this.benched.get(o) ?? 0) <= now);
    // With everything benched, try anyway rather than report no DAPI at all.
    const pool = live.length > 0 ? live : [...this.nodes];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }

  /** Skip `origin` for a while after it failed a call. */
  bench(origin: string): void {
    this.benched.set(origin, this.now() + BENCH_MS);
  }

  /** Resolves once any due refresh has finished. For tests and warm-up. */
  refresh(): Promise<void> {
    if (this.now() < this.nextRefresh) return Promise.resolve();
    this.refreshing ??= this.discover().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async discover(): Promise<void> {
    const sources = SOURCES[this.network];
    const attempts: Array<[string, string, (body: unknown) => string[]]> = [
      ["quorums", sources.quorums, parseQuorumService],
      ["explorer", sources.explorer, parseExplorer],
    ];
    for (const [name, url, parse] of attempts) {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const found = origins(parse(await res.json()));
        // A handful is not a list: keep what we had rather than shrink to it.
        if (found.length < MIN_LISTED) throw new Error(`only ${found.length} usable evonodes`);
        this.nodes = found;
        this.source = name;
        this.nextRefresh = this.now() + REFRESH_MS;
        return;
      } catch (err) {
        console.warn(`evonode discovery via ${name} failed: ${describeError(err)}`);
      }
    }
    this.nextRefresh = this.now() + RETRY_MS;
  }
}
