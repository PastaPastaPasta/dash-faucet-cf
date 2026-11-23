/**
 * `/` is the testnet faucet; mainnet is only identity invitations, at
 * `/invitations`. Family links carry the visitor's network (`?network=mainnet`),
 * so this sends those to the page that actually serves mainnet.
 */

/** Mirrors `parseNetwork` in public/dashhq/dashhq-shell.js. */
function parseNetwork(value: string | null): string | null {
  const v = value?.trim().toLowerCase();
  if (v === "mainnet" || v === "main") return "mainnet";
  if (v === "testnet" || v === "test") return "testnet";
  return v && /^devnet[-_ ]?[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? "devnet" : null;
}

/**
 * Where a request for `/` that asks for mainnet belongs, or null when it does
 * not ask for mainnet. `?network=` wins over the legacy `?net=`, as in the shell.
 */
export function mainnetHomeRedirect(url: URL): string | null {
  if (url.pathname !== "/") return null;
  const network =
    parseNetwork(url.searchParams.get("network")) ?? parseNetwork(url.searchParams.get("net"));
  if (network !== "mainnet") return null;
  const target = new URL("/invitations", url);
  for (const [key, value] of url.searchParams) {
    if (key !== "network" && key !== "net") target.searchParams.append(key, value);
  }
  return target.href;
}
