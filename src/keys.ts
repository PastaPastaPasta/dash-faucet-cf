import DashKeys from "dashkeys";
import Secp256k1 from "@dashincubator/secp256k1";
import type { NetworkName } from "./config";

export interface FaucetKey {
  privKeyBytes: Uint8Array;
  pubKeyBytes: Uint8Array;
  /** hex */
  pubKeyHash: string;
  address: string;
  network: NetworkName;
}

export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressError";
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Bitcoin base58 alphabet, as used by Platform identifiers. */
export const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 without a checksum (Platform identifiers). Throws on bad input. */
export function base58Decode(text: string): Uint8Array {
  if (typeof text !== "string" || text.length === 0) throw new Error("empty base58");
  let value = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) throw new Error("invalid base58 character");
    value = value * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (value > 0n) {
    body.push(Number(value % 256n));
    value /= 256n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const out = new Uint8Array(zeros + body.length);
  for (let i = 0; i < body.length; i += 1) out[out.length - 1 - i] = body[i];
  return out;
}

export async function loadFaucetKey(
  wif: string,
  network: NetworkName,
): Promise<FaucetKey> {
  let privKeyBytes: Uint8Array;
  try {
    privKeyBytes = await DashKeys.wifToPrivKey(wif.trim(), { version: network });
  } catch {
    // Never surface the underlying message — it can echo key material.
    throw new Error(`FAUCET_WIF is not a valid ${network} WIF`);
  }
  const pubKeyBytes = Secp256k1.getPublicKey(privKeyBytes, true);
  const pkhBytes = await DashKeys.pubkeyToPkh(pubKeyBytes);
  const address = await DashKeys.pkhToAddr(pkhBytes, { version: network });

  return {
    privKeyBytes,
    pubKeyBytes,
    pubKeyHash: bytesToHex(pkhBytes),
    address,
    network,
  };
}

const EXAMPLE_PREFIX: Record<NetworkName, string> = {
  mainnet: "X",
  testnet: "y",
};

/**
 * Validate a recipient address and return its pubKeyHash as hex.
 *
 * Checks the base58 checksum AND the network version byte, so a mainnet
 * address submitted to the testnet faucet (or vice versa) is rejected up front
 * rather than producing an unspendable payout.
 */
export async function addressToPubKeyHash(
  address: string,
  network: NetworkName,
): Promise<string> {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new AddressError("Address is required");
  }

  let parts;
  try {
    parts = await DashKeys.decode(trimmed, { version: network });
  } catch {
    throw new AddressError(
      `Not a valid ${network} Dash address (expected one starting with "${EXAMPLE_PREFIX[network]}")`,
    );
  }

  if (!parts.valid) {
    throw new AddressError("Address checksum is invalid");
  }
  if (parts.type !== "pkh" || !parts.pubKeyHash) {
    // decode() also accepts WIFs and extended keys for the same network.
    throw new AddressError("Not a pay-to-public-key-hash address");
  }
  return parts.pubKeyHash;
}
