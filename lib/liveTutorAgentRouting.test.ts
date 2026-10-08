import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_TUTOR_AGENT_NAME, isLiveTutorCloudCanaryUser, resolveLiveTutorAgentNameForUser } from './liveTutorAgentRouting';

describe('Live Tutor Cloud agent routing', () => {
  afterEach(() => {
    delete process.env.LIVE_TUTOR_CLOUD_AGENT_NAME;
    delete process.env.LIVE_TUTOR_CLOUD_AGENT_TEST_USER_EMAILS;
  });

  it('uses the stable production worker for every user', () => {
    process.env.LIVE_TUTOR_CLOUD_AGENT_NAME = 'mento-live-tutor-production';
    expect(resolveLiveTutorAgentNameForUser('canary@example.com')).toBe('mento-live-tutor-production');
    expect(resolveLiveTutorAgentNameForUser('other@example.com')).toBe('mento-live-tutor-production');
  });

  it('keeps the emergency deployment name server-controlled', () => {
    delete process.env.LIVE_TUTOR_CLOUD_AGENT_NAME;
    process.env.LIVE_TUTOR_CLOUD_AGENT_TEST_USER_EMAILS = 'canary@example.com';

    expect(resolveLiveTutorAgentNameForUser('CANARY@EXAMPLE.COM')).toBe(DEFAULT_LIVE_TUTOR_AGENT_NAME);
    expect(resolveLiveTutorAgentNameForUser('other@example.com')).toBe(DEFAULT_LIVE_TUTOR_AGENT_NAME);
    expect(resolveLiveTutorAgentNameForUser()).toBe(DEFAULT_LIVE_TUTOR_AGENT_NAME);
    expect(isLiveTutorCloudCanaryUser('canary@example.com')).toBe(true);
    expect(isLiveTutorCloudCanaryUser('other@example.com')).toBe(false);
  });

  it('matches the currently deployed worker when no override is configured', () => {
    delete process.env.LIVE_TUTOR_CLOUD_AGENT_NAME;
    expect(resolveLiveTutorAgentNameForUser('user@example.com')).toBe('mento-live-tutor-staging');
  });
});
