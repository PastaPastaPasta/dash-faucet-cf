/**
 * grpc-web builders for tests that stand in for DAPI. Deliberately independent
 * of src/chain/dapi.ts, so the tests check its encoder rather than reuse it.
 */
export function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

export function varintField(field: number, value: number): number[] {
  return [...varint(field * 8), ...varint(value)];
}

export function lengthDelimited(field: number, bytes: Uint8Array): number[] {
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
}

/** The payload of a request's field 1 — the only field these requests carry. */
export function field1(request: Uint8Array): Uint8Array {
  if (request.length === 0) return request;
  let i = 1;
  while (request[i] & 0x80) i++;
  return request.subarray(i + 1);
}

const GRPC_HEADERS = { "content-type": "application/grpc-web+proto" };

function frame(flags: number, payload: ArrayLike<number>): number[] {
  return [flags, ...[24, 16, 8, 0].map((shift) => (payload.length >>> shift) & 0xff), ...Array.from(payload)];
}

/** A message frame followed by an OK trailer frame. */
export function grpcOk(message: number[]): Response {
  const trailer = new TextEncoder().encode("grpc-status:0\r\n");
  return new Response(new Uint8Array([...frame(0, message), ...frame(0x80, trailer)]), {
    status: 200,
    headers: GRPC_HEADERS,
  });
}

/** A reply whose only frame is the trailer block, given verbatim. */
export function grpcTrailers(block: string): Response {
  return new Response(new Uint8Array(frame(0x80, new TextEncoder().encode(block))), {
    status: 200,
    headers: GRPC_HEADERS,
  });
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
