import { afterEach, describe, expect, it } from 'vitest';
import { clampLiveTutorExpiry, getLiveTutorMaxSessionSecondsForUser, LIVE_TUTOR_INACTIVITY_TIMEOUT_MS, LIVE_TUTOR_MAX_SESSION_SECONDS } from './liveTutorLimits';

describe('getLiveTutorMaxSessionSecondsForUser', () => {
  afterEach(() => {
    delete process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS;
    delete process.env.LIVE_TUTOR_TEST_USER_EMAILS;
  });

  it('applies a deployment test override only to explicitly listed users', () => {
    process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS = '120';
    process.env.LIVE_TUTOR_TEST_USER_EMAILS = 'tester@example.com';
    expect(getLiveTutorMaxSessionSecondsForUser('tester@example.com')).toBe(120);
    expect(getLiveTutorMaxSessionSecondsForUser('other@example.com')).toBe(LIVE_TUTOR_MAX_SESSION_SECONDS);
    expect(getLiveTutorMaxSessionSecondsForUser('TESTER@EXAMPLE.COM', 60)).toBe(60);
  });
});

describe('Live Tutor limits', () => {
  it('supports the currently sold wallets with a ninety-second inactivity window', () => {
    expect(LIVE_TUTOR_MAX_SESSION_SECONDS).toBe(14_400);
    expect(LIVE_TUTOR_INACTIVITY_TIMEOUT_MS).toBe(90_000);
  });

  it('uses the earlier of the provider and application expiry', () => {
    const now = Date.parse('2026-08-26T00:00:00.000Z');
    expect(clampLiveTutorExpiry('2026-08-26T05:00:00.000Z', now)).toBe('2026-08-26T04:00:00.000Z');
    expect(clampLiveTutorExpiry('2026-08-26T00:05:00.000Z', now)).toBe('2026-08-26T00:05:00.000Z');
    expect(clampLiveTutorExpiry(undefined, now, 600)).toBe('2026-08-26T00:10:00.000Z');
  });
});
