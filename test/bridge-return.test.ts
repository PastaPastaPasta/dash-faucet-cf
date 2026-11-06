import { expect, it } from 'vitest';
// @ts-expect-error Browser module is plain JavaScript.
import { bridgeReturnUrl } from '../public/bridge-return.js';
const origin = 'https://bridge.thepasta.org/?mode=create&journey=start&network=testnet';
it.each(['https://evil.test/', 'javascript:alert(1)', 'https://bridge.thepasta.org.evil.test/', 'https://bridge.thepasta.org/elsewhere', 'https://user@bridge.thepasta.org/'])('rejects an unsafe return %s', (url) => {
  expect(bridgeReturnUrl(new URLSearchParams({ return: url, address: 'public-address' }), origin)).toBeNull();
});
it('returns to the pending address and testnet, preserving no other network', () => {
  const url = new URL(bridgeReturnUrl(new URLSearchParams({ return: origin.replace('testnet','mainnet'), address: 'public-address' }), origin));
  expect(url.origin).toBe('https://bridge.thepasta.org');
  expect(url.searchParams.get('mode')).toBe('resume');
  expect(url.searchParams.get('network')).toBe('testnet');
  expect(url.searchParams.get('deposit')).toBe('public-address');
});
it('supports legacy two-product links without opening another tab', () => {
  expect(bridgeReturnUrl(new URLSearchParams({ from: 'bridge', address: 'public-address' }), origin)).toContain('mode=resume');
});
