/**
 * `fetch` for evonodes, over a raw TLS socket.
 *
 * Workers refuse to `fetch` a bare-IP URL (Cloudflare error 1003), and
 * evonodes are only addressable by IP. Their Let's Encrypt certificates carry
 * the IP as a SAN, though, and `cloudflare:sockets` may connect to an IP, so a
 * TLS socket to the evonode verifies normally. This writes one HTTP/1.1
 * request per connection (`Connection: close`) and reads the whole response —
 * the faucet only makes unary DAPI calls, so nothing needs to stream.
 *
 * Ported from PastaPastaPasta/dash-platform-workers `src/ip-fetch.js` and
 * `src/http1.js`, which run rs-sdk's proved reads and writes the same way.
 */
import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();
const SKIPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const MAX_HEAD = 64 * 1024;
/** DAPI replies to the calls the faucet makes are a few hundred bytes to a few KB. */
const MAX_BODY = 4 * 1024 * 1024;

export async function socketFetch(url: string, init: RequestInit): Promise<Response> {
  const req = new Request(url, init);
  const target = new URL(req.url);
  if (target.protocol !== "https:") throw new Error(`socketFetch needs https, got ${target.protocol}`);
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason;

  const body = new Uint8Array(await req.arrayBuffer());
  const socket = connect(
    { hostname: target.hostname, port: Number(target.port || 443) },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const close = () => {
    socket.close().catch(() => {});
  };
  signal?.addEventListener("abort", close);
  try {
    const writer = socket.writable.getWriter();
    await writer.write(encodeRequest(req, target, body));
    writer.releaseLock();
    return await readResponse(socket.readable, signal);
  } finally {
    signal?.removeEventListener("abort", close);
    close();
  }
}

export function encodeRequest(req: Request, url: URL, body: Uint8Array): Uint8Array {
  let head = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n`;
  for (const [name, value] of req.headers) {
    if (!SKIPPED_HEADERS.has(name)) head += `${name}: ${value}\r\n`;
  }
  head += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const headBytes = enc.encode(head);
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes);
  out.set(body, headBytes.length);
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Read a complete HTTP/1.x response (Content-Length, chunked, or delimited by
 * the connection closing) into a Response.
 */
export async function readResponse(
  readable: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Response> {
  const reader = readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      if (total > MAX_HEAD + MAX_BODY) throw new Error("HTTP response too large");
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const raw = concat(parts, total);

  const headEnd = indexOf(raw, enc.encode("\r\n\r\n"));
  if (headEnd < 0) throw new Error(total > MAX_HEAD ? "HTTP response head too large" : "truncated HTTP response");
  const [statusLine, ...lines] = dec.decode(raw.subarray(0, headEnd)).split("\r\n");
  const [version, code] = statusLine.split(" ");
  const status = Number(code);
  if (!/^HTTP\/1\.[01]$/.test(version ?? "") || !Number.isInteger(status)) {
    throw new Error(`malformed status line: ${statusLine}`);
  }
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  let rest = raw.subarray(headEnd + 4);
  if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) {
    rest = dechunk(rest);
    headers.delete("transfer-encoding");
  } else if (headers.has("content-length")) {
    const value = headers.get("content-length")!;
    if (!/^\d+$/.test(value)) throw new Error(`malformed content-length: ${value}`);
    const length = Number(value);
    if (rest.length < length) throw new Error("truncated HTTP body");
    rest = rest.subarray(0, length);
  }
  // 1xx/204/304 must not carry a body; Response refuses one for those.
  const empty = status === 204 || status === 304 || status < 200;
  return new Response(empty ? null : rest, { status, headers });
}

function dechunk(data: Uint8Array): Uint8Array {
  const crlf = enc.encode("\r\n");
  const parts: Uint8Array[] = [];
  let total = 0;
  let at = 0;
  for (;;) {
    const lineEnd = indexOf(data, crlf, at);
    if (lineEnd < 0) throw new Error("truncated chunked body");
    const line = dec.decode(data.subarray(at, lineEnd));
    const sizeText = line.split(";")[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error(`malformed chunk size: ${line}`);
    const size = parseInt(sizeText, 16);
    at = lineEnd + 2;
    if (size === 0) return concat(parts, total);
    if (at + size > data.length) throw new Error("truncated chunked body");
    parts.push(data.subarray(at, at + size));
    total += size;
    at += size + 2;
  }
}
