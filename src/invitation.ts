import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import DashKeys from "dashkeys";
import Secp256k1 from "@dashincubator/secp256k1";
import type { NetworkName } from "./config";
import { bytesToHex } from "./keys";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DEVICE_COOKIE = "dash_invite_device";
const DEVICE_MAX_AGE_SECS = 30 * 24 * 60 * 60;

export interface EncryptedSecret {
  cipherHex: string;
  ivHex: string;
}

export interface VoucherKey {
  wif: string;
  privateKey: Uint8Array;
  publicKeyHash: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function secretBytes(secret: string, purpose: string): Uint8Array {
  return sha256(encoder.encode(`${purpose}\0${secret}`));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function signature(secret: string, deviceId: string): string {
  return bytesToHex(
    hmac(sha256, secretBytes(secret, "device-cookie"), encoder.encode(deviceId)),
  );
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === DEVICE_COOKIE) return value.join("=");
  }
  return undefined;
}

/** Return a stable signed device ID, creating a cookie when none is valid. */
export function invitationDevice(
  request: Request,
  secret: string,
): { id: string; setCookie?: string } {
  const supplied = cookieValue(request);
  if (supplied) {
    const split = supplied.lastIndexOf(".");
    const id = supplied.slice(0, split);
    const mac = supplied.slice(split + 1);
    if (
      split > 0 &&
      /^[0-9a-f-]{36}$/i.test(id) &&
      /^[0-9a-f]{64}$/i.test(mac) &&
      constantTimeEqual(mac.toLowerCase(), signature(secret, id))
    ) {
      return { id };
    }
  }

  const id = crypto.randomUUID();
  const value = `${id}.${signature(secret, id)}`;
  return {
    id,
    setCookie:
      `${DEVICE_COOKIE}=${value}; Max-Age=${DEVICE_MAX_AGE_SECS}; Path=/; ` +
      "Secure; HttpOnly; SameSite=Strict",
  };
}

/** Pseudonymous durable key for an IP or device identifier. */
export function hashInvitationSignal(
  secret: string,
  kind: "ip" | "device",
  value: string,
): string {
  return bytesToHex(
    hmac(sha256, secretBytes(secret, "rate-limit"), encoder.encode(`${kind}:${value}`)),
  );
}

export async function encryptWif(
  wif: string,
  secret: string,
): Promise<EncryptedSecret> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret, "voucher-encryption"),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(wif),
  );
  return { cipherHex: bytesToHex(new Uint8Array(encrypted)), ivHex: bytesToHex(iv) };
}

export async function decryptWif(
  encrypted: EncryptedSecret,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret, "voucher-encryption"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(encrypted.ivHex) },
    key,
    hexToBytes(encrypted.cipherHex),
  );
  return decoder.decode(plain);
}

export async function generateVoucherKey(network: NetworkName): Promise<VoucherKey> {
  const privateKey = Secp256k1.utils.randomPrivateKey();
  const publicKey = Secp256k1.getPublicKey(privateKey, true);
  const publicKeyHash = bytesToHex(await DashKeys.pubkeyToPkh(publicKey));
  const wif = await DashKeys.privKeyToWif(privateKey, { version: network });
  return { wif, privateKey, publicKeyHash };
}

export function invitationUri(txid: string, wif: string): string {
  const query = new URLSearchParams({
    assetlocktx: txid,
    pk: wif,
    // Released Android requires the parameter to exist, and treats the literal
    // string "null" as the ChainAssetLockProof path.
    islock: "null",
  });
  return `dashpay://invite?${query.toString()}`;
}

function uint32Le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

/** Identity ID deterministically derived from the asset-lock credit outpoint. */
export function prospectiveIdentityId(txid: string, outputIndex = 0): string {
  const displayBytes = hexToBytes(txid);
  const outpoint = new Uint8Array(36);
  outpoint.set(displayBytes.reverse(), 0);
  outpoint.set(uint32Le(outputIndex), 32);
  return base58Encode(sha256(sha256(outpoint)));
}
