import { afterEach, describe, expect, it } from 'vitest';
import { clampLiveTutorExpiry, getLiveTutorMaxSessionSecondsForUser, LIVE_TUTOR_INACTIVITY_TIMEOUT_MS, LIVE_TUTOR_MAX_SESSION_SECONDS } from './liveTutorLimits';

const originalSeconds = process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS;
const originalEmails = process.env.LIVE_TUTOR_TEST_USER_EMAILS;

afterEach(() => {
  if (originalSeconds === undefined) delete process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS;
  else process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS = originalSeconds;
  if (originalEmails === undefined) delete process.env.LIVE_TUTOR_TEST_USER_EMAILS;
  else process.env.LIVE_TUTOR_TEST_USER_EMAILS = originalEmails;
});

describe('getLiveTutorMaxSessionSecondsForUser', () => {
  it('uses a short test limit only for an exact whitelisted account', () => {
    process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS = '120';
    process.env.LIVE_TUTOR_TEST_USER_EMAILS = 'tester@example.com';

    expect(getLiveTutorMaxSessionSecondsForUser('Tester@example.com')).toBe(120);
    expect(getLiveTutorMaxSessionSecondsForUser('another@example.com')).toBe(LIVE_TUTOR_MAX_SESSION_SECONDS);
  });

  it('keeps the production limit when test configuration is incomplete', () => {
    delete process.env.LIVE_TUTOR_TEST_USER_EMAILS;
    process.env.LIVE_TUTOR_TEST_MAX_SESSION_SECONDS = '120';

    expect(getLiveTutorMaxSessionSecondsForUser('tester@example.com')).toBe(LIVE_TUTOR_MAX_SESSION_SECONDS);
  });
});

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
