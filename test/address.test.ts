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
});
