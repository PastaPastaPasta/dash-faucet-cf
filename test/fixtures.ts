/**
 * Test vectors, derived from hard-coded private keys.
 *
 * These WIFs are public: anyone reading this file can spend anything sent to
 * the matching addresses. Never fund them, on either network.
 */

export const FAUCET = {
  testnet: {
    wif: "cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87f2krBRv7",
    address: "yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs",
    pubKeyHash: "9290649ba520a35912dab1733b6f098587e432ef",
  },
  mainnet: {
    wif: "XBHddvWWiMu3nZhhpTXBQWJMmdz5JNKJD85b9fgKAckCoSri4D8g",
    address: "Xp3oTrxmd5JL6qA1MKFDjkUeqgGXuRfGjv",
    pubKeyHash: "9290649ba520a35912dab1733b6f098587e432ef",
  },
};

export const RECIPIENT = {
  testnet: {
    address: "yfJZVF5WhFsVXCvqiR4JqAM3TmEf3LpPfw",
    pubKeyHash: "d03f83fcf1e21682ea7cae8430389fec20e9d4f9",
  },
  mainnet: {
    address: "XufxUJ15FiDRBU1J9Zjuo8vhBUkHT6bXv1",
    pubKeyHash: "d03f83fcf1e21682ea7cae8430389fec20e9d4f9",
  },
};

/** P2PKH locking script for the testnet faucet address. */
export const FAUCET_SCRIPT_TESTNET =
  `76a914${FAUCET.testnet.pubKeyHash}88ac`;

export function utxo(
  txidByte: string,
  outputIndex: number,
  satoshis: number,
  script = FAUCET_SCRIPT_TESTNET,
) {
  return {
    txid: txidByte.repeat(64).slice(0, 64),
    outputIndex,
    satoshis,
    script,
    height: 1_000_000,
  };
}
