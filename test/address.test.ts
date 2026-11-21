import { describe, expect, it } from 'vitest';
import { addressError } from '../public/address.js';

const valid = 'yZgQUp3D4cxQSa5YvAZcmmu17xkuSk1uKs';
describe('browser receiving address checks', () => {
  it('accepts an independently checked Testnet address', async () => {
    expect(await addressError(valid, 'testnet')).toBe('');
  });
  it('rejects wrong networks, typos and malformed addresses', async () => {
    expect(await addressError(valid, 'mainnet')).toContain('Mainnet');
    expect(await addressError(valid.slice(0, -1) + 't', 'testnet')).toContain('checksum');
    expect(await addressError('yNotARealAddress', 'testnet')).toContain('34 characters');
    expect(await addressError('', 'testnet')).toContain('Testnet');
  });
  it('accepts pay-to-public-key-hash only, as the Worker pays', async () => {
    expect(await addressError('XbKzysY6LYGbsGwNG8B7K1BRoA1ffLodAT', 'mainnet')).toBe('');
    expect(await addressError('8eWmb1WDYYfnviGcfaTBZjftxGpCwriip5', 'testnet')).toContain('starting with y');
    expect(await addressError('93m4hAxmCcGXMfnjVPfNhWSjb69sBgdWN2', 'testnet')).toContain('starting with y');
    expect(await addressError('7SVxdgcMR1HAUQrMbKTE7MrY4m3NmuyV5U', 'mainnet')).toContain('starting with X');
  });
});
