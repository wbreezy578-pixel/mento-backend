import { describe, expect, it } from 'vitest';
import { clampLiveTutorExpiry, LIVE_TUTOR_INACTIVITY_TIMEOUT_MS, LIVE_TUTOR_MAX_SESSION_SECONDS } from './liveTutorLimits';

describe('Live Tutor limits', () => {
  it('limits sessions to twenty minutes with a ninety-second inactivity window', () => {
    expect(LIVE_TUTOR_MAX_SESSION_SECONDS).toBe(1200);
    expect(LIVE_TUTOR_INACTIVITY_TIMEOUT_MS).toBe(90_000);
  });

  it('uses the earlier of the provider and application expiry', () => {
    const now = Date.parse('2026-08-26T00:00:00.000Z');
    expect(clampLiveTutorExpiry('2026-08-26T01:00:00.000Z', now)).toBe('2026-08-26T00:20:00.000Z');
    expect(clampLiveTutorExpiry('2026-08-26T00:05:00.000Z', now)).toBe('2026-08-26T00:05:00.000Z');
  });
});
