import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { afterEach } from "vitest";
import { TREASURY_ID } from "../../src/treasury";

/**
 * Payouts and merges book a maintenance alarm a few seconds out. One that
 * outlives its test fires into a later test's fake chain, or after vitest has
 * torn down, so every test ends by cancelling what it booked. Tests create a
 * fresh Treasury each, so one cleared at the end of its test stays clear; the
 * shared one the Worker routes to is cleared every time.
 */
const cleared = new Set<string>();
const shared = env.TREASURY.idFromName(TREASURY_ID).toString();

afterEach(async () => {
  for (const id of await listDurableObjectIds(env.TREASURY)) {
    const key = id.toString();
    if (cleared.has(key)) continue;
    await runInDurableObject(env.TREASURY.get(id), (_, state) => state.storage.deleteAlarm());
    if (key !== shared) cleared.add(key);
  }
});
