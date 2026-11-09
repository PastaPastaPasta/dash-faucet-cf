import { describe, expect, it } from 'vitest';
import { reserveCoverage } from '../public/reserve-status.js';

describe('reserve coverage at the reported daily payout budget', () => {
  it('requires at least a full day for a healthy reserve', () => {
    expect(reserveCoverage(1, 100_000_000, 'tDASH').state).toBe('good');
    expect(reserveCoverage(0.99999999, 100_000_000, 'tDASH').state).toBe('warn');
    expect(reserveCoverage(0, 100_000_000, 'tDASH').state).toBe('warn');
  });

  it('does not infer health from missing or malformed balances and budgets', () => {
    for (const balance of [NaN, Infinity, -1]) {
      expect(reserveCoverage(balance, 100_000_000, 'DASH')).toEqual({ state: 'unknown', label: 'Balance unavailable' });
    }
    for (const budget of [undefined, NaN, Infinity, 0, -1]) {
      expect(reserveCoverage(1000, budget, 'DASH')).toEqual({ state: 'unknown', label: 'Daily payout budget unavailable' });
    }
  });

  it('names the threshold and network currency without rounding a low balance up', () => {
    expect(reserveCoverage(0.00000002, 3, 'tDASH')).toEqual({ state: 'warn', label: 'Under a day of payouts · 0.00000003 tDASH/day' });
  });
});
