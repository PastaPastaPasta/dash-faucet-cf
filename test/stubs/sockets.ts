// Node has no `cloudflare:sockets`; unit tests never open a socket.
export function connect(): never {
  throw new Error("cloudflare:sockets is not available in unit tests");
}
