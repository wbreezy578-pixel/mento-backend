import { describe, expect, it } from 'vitest';
import { getAvailableLiveTutorSeconds } from './entitlementService';

describe('canonical Live Tutor balance', () => {
  it('does not restore depleted seconds from a stale legacy minute balance', () => {
    expect(getAvailableLiveTutorSeconds({ includedSeconds: 0, topUpSeconds: 0 })).toBe(0);
    expect(getAvailableLiveTutorSeconds({ includedSeconds: 0, topUpSeconds: 0, minutesBalance: 120 })).toBe(0);
    expect(getAvailableLiveTutorSeconds({ includedSeconds: 30, topUpSeconds: 15, minutesBalance: 120 })).toBe(45);
  });
});
