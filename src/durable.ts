/** Stubs for the faucet's Durable Objects. */
import type { Env } from "./config";
import { TREASURY_ID } from "./treasury";

export function treasury(env: Env) {
  return env.TREASURY.get(env.TREASURY.idFromName(TREASURY_ID));
}

export function invitationTreasury(env: Env) {
  if (!env.INVITATION_TREASURY) {
    throw new Error("INVITATION_TREASURY binding is not configured");
  }
  return env.INVITATION_TREASURY.get(env.INVITATION_TREASURY.idFromName(TREASURY_ID));
}
