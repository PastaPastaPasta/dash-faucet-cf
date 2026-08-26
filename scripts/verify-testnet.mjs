#!/usr/bin/env node
/**
 * End-to-end verification against a running faucet and the live testnet chain.
 *
 *   npm run dev                       # in another shell
 *   node scripts/verify-testnet.mjs   # optionally: --base http://127.0.0.1:8787
 *
 * Requires the faucet to hold spendable testnet coins. Nothing here is mocked:
 * every transaction is built, signed, broadcast, and then read back from a
 * public node that had no part in creating it.
 */

import DashKeys from "dashkeys";
import Secp256k1 from "@dashincubator/secp256k1";

const BASE =
  process.argv.includes("--base")
    ? process.argv[process.argv.indexOf("--base") + 1]
    : "http://127.0.0.1:8787";
const RPC = "https://trpc.digitalcash.dev/";

let failures = 0;
function check(name, condition, detail = "") {
  const mark = condition ? "  ok  " : " FAIL ";
  if (!condition) failures += 1;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function freshAddress() {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  const pub = Secp256k1.getPublicKey(priv, true);
  return DashKeys.pkhToAddr(await DashKeys.pubkeyToPkh(pub), { version: "testnet" });
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function requestPayout(address, ip) {
  const headers = { "content-type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return api("/api/core-faucet", {
    method: "POST",
    headers,
    body: JSON.stringify({ address }),
  });
}

console.log(`verifying ${BASE} against live testnet\n`);

// --- status -----------------------------------------------------------------
const status = await api("/api/status");
check("GET /api/status responds", status.status === 200 || status.status === 503);
const s = status.body;
check("reports the testnet network", s.network === "testnet", s.network);
check("exposes a deposit address", /^y/.test(s.depositAddress ?? ""), s.depositAddress);
check(
  "at least one chain provider is healthy",
  (s.providers ?? []).some((p) => p.ok),
  (s.providers ?? []).map((p) => `${p.name}:${p.ok ? "ok" : "down"}`).join(" "),
);
check("block height looks live", s.blockHeight > 1_000_000, String(s.blockHeight));

if (s.balanceSats === 0) {
  console.log(`\nfaucet is empty — fund ${s.depositAddress} and re-run.`);
  process.exit(failures ? 1 : 0);
}

// --- captcha tiers ----------------------------------------------------------
// Shapes only. Never solve the hard challenge here: 50 × 16^6 is ~839M hashes,
// a quarter-hour of CPU, and proves nothing this check does not already.
const work = (p) => (p ? p.c * 16 ** p.d : 0);
const shape = (r) =>
  r.body.challenge ? `c=${r.body.challenge.c} s=${r.body.challenge.s} d=${r.body.challenge.d}` : "none";

const soft = await api("/cap/v1/challenge", { method: "POST" });
const hard = await api("/cap/hard/challenge", { method: "POST" });
if (soft.status === 503 && hard.status === 503) {
  console.log("[ skip ] proof-of-work captcha is not configured on this instance");
} else {
  check(
    "advertises the escalated cap endpoint",
    /\/cap\/hard\/$/.test(s.hardCapEndpoint ?? ""),
    s.hardCapEndpoint,
  );
  check(
    "serves both challenge tiers",
    soft.status === 200 && hard.status === 200,
    `${shape(soft)} | ${shape(hard)}`,
  );
  check(
    "the hard tier costs strictly more work",
    work(hard.body.challenge) > work(soft.body.challenge),
    `${work(hard.body.challenge)} vs ${work(soft.body.challenge)} hashes`,
  );
}

// --- validation -------------------------------------------------------------
const mainnetAddr = "XufxUJ15FiDRBU1J9Zjuo8vhBUkHT6bXv1";
const wrongNet = await requestPayout(mainnetAddr);
check("rejects a mainnet address", wrongNet.status === 400, wrongNet.body.error);

const badSum = await requestPayout("yfJZVF5WhFsVXCvqiR4JqAM3TmEf3LpPfX");
check("rejects a bad checksum", badSum.status === 400, badSum.body.error);

const errShape = wrongNet.body;
check(
  "error body keeps the legacy detail shape",
  typeof errShape.error === "string" && typeof errShape.detail?.error === "string",
);

// --- payout -----------------------------------------------------------------
const target = await freshAddress();
const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
const pay = await requestPayout(target, ip);
check("payout succeeds", pay.status === 200, pay.body.error ?? pay.body.txid);

if (pay.status === 200) {
  const { txid } = pay.body;

  const replay = await requestPayout(target, ip);
  check(
    "repeat request replays instead of paying twice",
    replay.status === 200 && replay.body.txid === txid && replay.body.replay === true,
  );

  // --- independent on-chain verification ------------------------------------
  const tx = await rpc("getrawtransaction", [txid, 1]);
  check("network accepted the transaction", tx.txid === txid);
  check("transaction is Dash version 3", tx.version === 3, String(tx.version));

  const paid = tx.vout.find((o) => {
    const spk = o.scriptPubKey;
    const addrs = spk.addresses ?? (spk.address ? [spk.address] : []);
    return addrs.includes(target);
  });
  check("recipient output is present", Boolean(paid), target);
  check(
    "recipient received the advertised amount",
    paid && Math.round(paid.value * 1e8) === Math.round(pay.body.amount * 1e8),
    paid ? `${paid.value} vs ${pay.body.amount}` : "",
  );

  const outTotal = tx.vout.reduce((acc, o) => acc + Math.round(o.value * 1e8), 0);
  const inputs = await Promise.all(
    tx.vin.map(async (i) => {
      const prev = await rpc("getrawtransaction", [i.txid, 1]);
      return Math.round(prev.vout[i.vout].value * 1e8);
    }),
  );
  const inTotal = inputs.reduce((a, b) => a + b, 0);
  const fee = inTotal - outTotal;
  check("fee is positive and sane", fee > 0 && fee < 100_000, `${fee} duffs for ${tx.size} bytes`);
  check("fee rate is at least 1 duff/byte", fee >= tx.size, `${(fee / tx.size).toFixed(2)} duff/byte`);

  const [islock] = await rpc("getislocks", [[txid]]);
  check("InstantSend lock present", Boolean(islock));
}

console.log(
  failures === 0
    ? "\nall checks passed"
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures ? 1 : 0);
