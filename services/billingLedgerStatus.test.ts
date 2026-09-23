import { describe, expect, it } from 'vitest';
import { resolveUsageLogSuccess } from './billingLedgerStatus';

describe('usage ledger status', () => {
  it('never records a denied charge as completed', () => {
    expect(resolveUsageLogSuccess(false, false, true)).toBe(false);
    expect(resolveUsageLogSuccess(false, true, true)).toBe(false);
    expect(resolveUsageLogSuccess(false, false, undefined)).toBe(false);
  });

  it('preserves pending and completed allowed operations', () => {
    expect(resolveUsageLogSuccess(true, true, true)).toBeNull();
    expect(resolveUsageLogSuccess(true, false, true)).toBe(true);
    expect(resolveUsageLogSuccess(true, false, false)).toBe(false);
  });
});
