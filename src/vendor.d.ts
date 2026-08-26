/**
 * Minimal ambient declarations for the three vendored crypto libraries, none of
 * which ship a `types` entry. Only the surface this project actually uses is
 * declared, so a breaking upstream change shows up as a type error here.
 */

declare module "dashkeys" {
  export interface KeyOpts {
    version?: "mainnet" | "testnet";
    validate?: boolean;
  }
  export interface DecodedParts {
    version: string;
    type: "pkh" | "private" | "xprv" | "xpub";
    pubKeyHash?: string;
    privateKey?: string;
    valid: boolean;
  }
  export function decode(keyB58c: string, opts?: KeyOpts): Promise<DecodedParts>;
  export function wifToPrivKey(wif: string, opts?: KeyOpts): Promise<Uint8Array>;
  export function privKeyToWif(
    privateKey: Uint8Array,
    opts?: KeyOpts,
  ): Promise<string>;
  export function pubkeyToPkh(pubBytes: Uint8Array): Promise<Uint8Array>;
  export function pkhToAddr(pkhBytes: Uint8Array, opts?: KeyOpts): Promise<string>;
  const DashKeys: {
    decode: typeof decode;
    wifToPrivKey: typeof wifToPrivKey;
    privKeyToWif: typeof privKeyToWif;
    pubkeyToPkh: typeof pubkeyToPkh;
    pkhToAddr: typeof pkhToAddr;
  };
  export default DashKeys;
}

declare module "@dashincubator/secp256k1" {
  export interface SignOpts {
    canonical?: boolean;
    der?: boolean;
    extraEntropy?: Uint8Array | string | true;
  }
  export function getPublicKey(
    privateKey: Uint8Array,
    isCompressed?: boolean,
  ): Uint8Array;
  export function sign(
    msgHash: Uint8Array,
    privateKey: Uint8Array,
    opts?: SignOpts,
  ): Promise<Uint8Array>;
  export const utils: {
    randomPrivateKey(): Uint8Array;
  };
  const Secp256k1: {
    getPublicKey: typeof getPublicKey;
    sign: typeof sign;
    utils: typeof utils;
  };
  export default Secp256k1;
}

declare module "dashtx" {
  export interface TxInput {
    txid: string;
    outputIndex: number;
    satoshis: number;
    script?: string;
    pubKeyHash?: string;
    publicKey?: string;
  }
  export interface TxOutput {
    satoshis: number;
    pubKeyHash?: string;
    address?: string;
    memo?: string;
    script?: string;
  }
  export interface TxDraft {
    inputs: TxInput[];
    outputs: TxOutput[];
    change: TxOutput | null;
    feeTarget: number;
    fullTransfer: boolean;
  }
  export interface TxSummary extends TxDraft {
    version?: number;
    type?: number;
    extraPayload?: string;
    transaction: string;
  }
  export interface KeyUtils {
    getPrivateKey(input: TxInput, i: number): Promise<Uint8Array>;
    getPublicKey(input: TxInput, i: number): Promise<Uint8Array>;
    sign(privKeyBytes: Uint8Array, txHashBytes: Uint8Array): Promise<Uint8Array>;
  }
  export interface TxInstance {
    hashAndSignAll(txInfo: unknown, sigHashType?: number): Promise<TxSummary>;
    legacy: {
      draftSingleOutput(opts: {
        utxos: TxInput[];
        inputs?: TxInput[];
        output: TxOutput;
      }): TxDraft;
      finalizePresorted(draft: TxDraft): Promise<TxSummary>;
    };
  }
  const DashTx: {
    create(keyUtils: KeyUtils): TxInstance;
    getId(txHex: string): Promise<string>;
    sortInputs(a: TxInput, b: TxInput): number;
    sortOutputs(a: TxOutput, b: TxOutput): number;
    sum(items: Array<{ satoshis: number }>): number;
    appraise(txInfo: unknown): { min: number; mid: number; max: number };
    createPkhScript(pubKeyHash: string): string;
    LEGACY_DUST: number;
  };
  export default DashTx;
}
