/** grpc-web response builders for tests that stand in for DAPI. */
export function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

/** Bytes taken by a field-1 tag plus its varint length prefix. */
export function lengthPrefix(message: Uint8Array): number {
  let i = 1;
  while (message[i] & 0x80) i++;
  return i + 1;
}

export function lengthDelimited(field: number, bytes: Uint8Array): number[] {
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
}

const GRPC_HEADERS = { "content-type": "application/grpc-web+proto" };

export function grpcOk(message: number[]): Response {
  const trailer = new TextEncoder().encode("grpc-status:0\r\n");
  const body = new Uint8Array(5 + message.length + 5 + trailer.length);
  const view = new DataView(body.buffer);
  view.setUint32(1, message.length);
  body.set(message, 5);
  const t = 5 + message.length;
  body[t] = 0x80;
  view.setUint32(t + 1, trailer.length);
  body.set(trailer, t + 5);
  return new Response(body, { status: 200, headers: GRPC_HEADERS });
}

/** A "trailers-only" reply: the status rides in the HTTP headers. */
export function grpcStatus(code: number, message: string): Response {
  return new Response(null, {
    status: 200,
    headers: {
      ...GRPC_HEADERS,
      "grpc-status": String(code),
      "grpc-message": encodeURIComponent(message),
    },
  });
}
