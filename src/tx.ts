import DashTx from "dashtx";
import type { KeyUtils, TxInput, TxOutput } from "dashtx";
import Secp256k1 from "@dashincubator/secp256k1";
import type { Utxo } from "./chain";
import type { FaucetKey } from "./keys";

export interface Outpoint {
  txid: string;
  outputIndex: number;
}

export interface BuiltTx {
  hex: string;
  txid: string;
  inputs: Outpoint[];
  /**
   * Every output that pays back to the faucet address: the change output for a
   * payout, or all of the new pool coins for a split. These are recorded as
   * in-flight so the next request can spend them before they confirm.
   */
  ownOutputs: Array<Outpoint & { satoshis: number }>;
  fee: number;
  totalIn: number;
}

export class InsufficientFundsError extends Error {
  constructor(
    readonly available: number,
    readonly required: number,
  ) {
    super(
      `insufficient funds: ${available} duffs available, ${required} required`,
    );
    this.name = "InsufficientFundsError";
  }
}

/**
 * The recipient is the faucet's own address. Refused because a payout's change
 * shares that pubKeyHash, so `finish()` — which identifies our outputs by
 * script — would record the recipient output as in-flight change and corrupt
 * the ledger. Client error, not a server fault.
 */
export class SelfPayError extends Error {
  constructor() {
    super("refusing to pay the faucet's own address");
    this.name = "SelfPayError";
  }
}

const DUMMY_PKH = "00".repeat(20);

/**
 * Worst-case size in duffs for a transaction of this shape, at 1 duff/byte.
 * Uses the max (padded-signature) appraisal so selection never comes up short
 * after signing.
 */
function feeCeiling(
  numInputs: number,
  numOutputs: number,
  extraPayloadBytes = 0,
): number {
  const inputs: TxInput[] = Array.from({ length: numInputs }, () => ({
    txid: "00".repeat(32),
    outputIndex: 0,
    satoshis: 1,
    pubKeyHash: DUMMY_PKH,
  }));
  const outputs: TxOutput[] = Array.from({ length: numOutputs }, () => ({
    satoshis: 1,
    pubKeyHash: DUMMY_PKH,
  }));
  // Special transactions append CompactSize(payload length) + payload after
  // locktime. Invitation payloads are well below 253 bytes, so the prefix is
  // one byte. Appraise intentionally uses full P2PKH outputs for the ceiling;
  // the asset lock's OP_RETURN is smaller, making this conservative.
  return (
    DashTx.appraise({ inputs, outputs }).max +
    (extraPayloadBytes > 0 ? 1 + extraPayloadBytes : 0)
  );
}

function keyUtilsFor(key: FaucetKey): KeyUtils {
  return {
    getPrivateKey: async () => key.privKeyBytes,
    getPublicKey: async () => key.pubKeyBytes,
    // extraEntropy makes signatures non-deterministic, which is what dashtx's
    // fee-targeting loop needs to re-roll a signature that came out too long.
    // Idempotency does not rely on stable txids — the Treasury ledger owns it.
    sign: async (privKeyBytes, txHashBytes) =>
      Secp256k1.sign(txHashBytes, privKeyBytes, {
        canonical: true,
        der: true,
        extraEntropy: true,
      }),
  };
}

function toTxInput(u: Utxo): TxInput {
  return {
    txid: u.txid,
    outputIndex: u.outputIndex,
    satoshis: u.satoshis,
    script: u.script,
  };
}

/**
 * Prefer a single input that covers the payout. One input means one ECDSA
 * signature, which keeps the request inside the Workers CPU budget and keeps
 * each pool coin on its own independent mempool chain.
 */
export function selectInputs(
  utxos: Utxo[],
  target: number,
  numOutputs = 2,
  extraPayloadBytes = 0,
): Utxo[] {
  const ascending = [...utxos].sort((a, b) => a.satoshis - b.satoshis);

  const single = ascending.find(
    (u) =>
      u.satoshis >= target + feeCeiling(1, numOutputs, extraPayloadBytes),
  );
  if (single) return [single];

  const picked: Utxo[] = [];
  let sum = 0;
  for (const u of [...ascending].reverse()) {
    picked.push(u);
    sum += u.satoshis;
    if (
      sum >= target + feeCeiling(picked.length, numOutputs, extraPayloadBytes)
    ) {
      return picked;
    }
  }

  const available = utxos.reduce((acc, u) => acc + u.satoshis, 0);
  throw new InsufficientFundsError(
    available,
    target +
      feeCeiling(Math.max(1, utxos.length), numOutputs, extraPayloadBytes),
  );
}

function uint64LeHex(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Version-1 asset-lock payload containing one P2PKH credit output. */
export function assetLockPayload(
  publicKeyHash: string,
  satoshis: number,
): string {
  if (!/^[0-9a-f]{40}$/i.test(publicKeyHash)) {
    throw new Error("asset lock public key hash must be 20 bytes");
  }
  const p2pkh = `76a914${publicKeyHash.toLowerCase()}88ac`;
  // payload version | output count | value | script length | script
  return `0101${uint64LeHex(satoshis)}19${p2pkh}`;
}

/**
 * Build a v3/type-8 asset lock with an exact voucher credit output and normal
 * P2PKH change back to the faucet.
 */
export async function buildInvitationAssetLock(opts: {
  key: FaucetKey;
  utxos: Utxo[];
  voucherPublicKeyHash: string;
  satoshis: number;
}): Promise<BuiltTx> {
  const { key, utxos, voucherPublicKeyHash, satoshis } = opts;
  const extraPayload = assetLockPayload(voucherPublicKeyHash, satoshis);
  const selected = selectInputs(utxos, satoshis, 2, extraPayload.length / 2);
  const totalIn = selected.reduce((sum, input) => sum + input.satoshis, 0);
  const fee = feeCeiling(selected.length, 2, extraPayload.length / 2);
  const changeSats = totalIn - satoshis - fee;

  const outputs: TxOutput[] = [{ satoshis, memo: "" }];
  if (changeSats > DashTx.LEGACY_DUST) {
    outputs.push({ satoshis: changeSats, pubKeyHash: key.pubKeyHash });
  } else if (changeSats < 0) {
    throw new InsufficientFundsError(totalIn, satoshis + fee);
  }

  const inputs = selected.map(toTxInput);
  inputs.sort(DashTx.sortInputs);
  outputs.sort(DashTx.sortOutputs);

  const dashTx = DashTx.create(keyUtilsFor(key));
  const signed = await dashTx.hashAndSignAll({
    version: 3,
    type: 8,
    inputs,
    outputs,
    locktime: 0,
    extraPayload,
  });

  const burn = signed.outputs.find(
    (output) => output.memo === "" && output.satoshis === satoshis,
  );
  if (!burn || signed.extraPayload !== extraPayload) {
    throw new Error("refusing to broadcast malformed invitation asset lock");
  }

  return finish(signed, key, totalIn);
}

async function finish(
  signed: { transaction: string; inputs: TxInput[]; outputs: TxOutput[] },
  key: FaucetKey,
  totalIn: number,
): Promise<BuiltTx> {
  const hex = signed.transaction;
  const txid = await DashTx.getId(hex);

  const totalOut = signed.outputs.reduce((acc, o) => acc + o.satoshis, 0);

  // Identify our own outputs by script rather than by position. A payout has
  // exactly one (the change); a split has all of them.
  const ownOutputs: Array<Outpoint & { satoshis: number }> = [];
  for (let i = 0; i < signed.outputs.length; i += 1) {
    if (signed.outputs[i].pubKeyHash === key.pubKeyHash) {
      ownOutputs.push({ txid, outputIndex: i, satoshis: signed.outputs[i].satoshis });
    }
  }

  return {
    hex,
    txid,
    inputs: signed.inputs.map((i) => ({
      txid: i.txid,
      outputIndex: i.outputIndex,
    })),
    ownOutputs,
    fee: totalIn - totalOut,
    totalIn,
  };
}

/** Build and sign a payout: one recipient output plus change back to the faucet. */
export async function buildPayout(opts: {
  key: FaucetKey;
  utxos: Utxo[];
  recipientPubKeyHash: string;
  satoshis: number;
}): Promise<BuiltTx> {
  const { key, utxos, recipientPubKeyHash, satoshis } = opts;

  if (recipientPubKeyHash === key.pubKeyHash) {
    throw new SelfPayError();
  }

  const selected = selectInputs(utxos, satoshis, 2);
  const dashTx = DashTx.create(keyUtilsFor(key));

  const draft = dashTx.legacy.draftSingleOutput({
    utxos: utxos.map(toTxInput),
    inputs: selected.map(toTxInput),
    output: { pubKeyHash: recipientPubKeyHash, satoshis },
  });

  // draftSingleOutput leaves change unaddressed; point it back at the faucet.
  if (draft.change) {
    draft.change.pubKeyHash = key.pubKeyHash;
    delete draft.change.address;
  }
  // BIP69 ordering. dashtx warns when inputs/outputs are unsorted and says it
  // will become an exception, so sort rather than carry a known future break.
  draft.inputs.sort(DashTx.sortInputs);
  draft.outputs.sort(DashTx.sortOutputs);

  const totalIn = DashTx.sum(draft.inputs);
  const signed = await dashTx.legacy.finalizePresorted(draft);

  // dashtx has a fallback path (_signFeeWalk) that shaves duffs off the *last*
  // output on the assumption it is change. That assumption does not survive
  // sorting, and it only runs for signers without entropy — ours has it — but
  // the cost of being wrong is paying the recipient the wrong amount, so
  // verify rather than reason about it.
  const paid = signed.outputs.find((o) => o.pubKeyHash === recipientPubKeyHash);
  if (!paid || paid.satoshis !== satoshis) {
    throw new Error(
      `refusing to broadcast: recipient output is ${paid?.satoshis ?? "missing"}, expected ${satoshis}`,
    );
  }

  return finish(signed, key, totalIn);
}

/**
 * Build and sign a self-send that splits one large coin into `count` equal
 * outputs. Keeping several independent pool coins is what stops Dash's
 * 25-ancestor mempool limit from stalling the faucet under burst.
 */
export async function buildSplit(opts: {
  key: FaucetKey;
  utxos: Utxo[];
  count: number;
  perOutputSats: number;
}): Promise<BuiltTx> {
  const { key, utxos, count, perOutputSats } = opts;
  if (count < 2) throw new Error("split requires at least 2 outputs");

  const target = count * perOutputSats;
  const selected = selectInputs(utxos, target, count + 1);
  const totalIn = selected.reduce((acc, u) => acc + u.satoshis, 0);

  const outputs: TxOutput[] = Array.from({ length: count }, () => ({
    satoshis: perOutputSats,
    pubKeyHash: key.pubKeyHash,
  }));

  // Pay the worst-case fee outright: a maintenance transaction that always
  // relays is worth more than a few hundred duffs of optimisation.
  const fee = feeCeiling(selected.length, count + 1);
  const changeSats = totalIn - target - fee;
  if (changeSats > DashTx.LEGACY_DUST) {
    outputs.push({ satoshis: changeSats, pubKeyHash: key.pubKeyHash });
  } else if (changeSats < 0) {
    throw new InsufficientFundsError(totalIn, target + fee);
  }

  const inputs = selected.map(toTxInput);
  inputs.sort(DashTx.sortInputs);

  const dashTx = DashTx.create(keyUtilsFor(key));
  outputs.sort(DashTx.sortOutputs);
  const signed = await dashTx.hashAndSignAll({ inputs, outputs });

  const built = await finish(signed, key, totalIn);
  const pool = built.ownOutputs.filter((o) => o.satoshis === perOutputSats);
  if (pool.length < count) {
    throw new Error(
      `refusing to broadcast: split produced ${pool.length} pool coins, expected ${count}`,
    );
  }
  return built;
}
