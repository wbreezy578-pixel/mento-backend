import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_TUTOR_AGENT_NAME, resolveLiveTutorAgentNameForUser } from './liveTutorAgentRouting';

describe('Live Tutor Cloud agent canary routing', () => {
  afterEach(() => {
    delete process.env.LIVE_TUTOR_CLOUD_AGENT_NAME;
    delete process.env.LIVE_TUTOR_CLOUD_AGENT_TEST_USER_EMAILS;
  });

  it('keeps all users on staging without a complete server configuration', () => {
    process.env.LIVE_TUTOR_CLOUD_AGENT_NAME = 'mento-live-tutor-production';
    expect(resolveLiveTutorAgentNameForUser('mentotest99@gmail.com')).toBe(DEFAULT_LIVE_TUTOR_AGENT_NAME);
  });

  it('routes only the explicitly configured user to the Cloud agent', () => {
    process.env.LIVE_TUTOR_CLOUD_AGENT_NAME = 'mento-live-tutor-production';
    process.env.LIVE_TUTOR_CLOUD_AGENT_TEST_USER_EMAILS = 'mentotest99@gmail.com';

    expect(resolveLiveTutorAgentNameForUser('MENTOTEST99@gmail.com')).toBe('mento-live-tutor-production');
    expect(resolveLiveTutorAgentNameForUser('other@example.com')).toBe(DEFAULT_LIVE_TUTOR_AGENT_NAME);
    expect(resolveLiveTutorAgentNameForUser()).toBe(DEFAULT_LIVE_TUTOR_AGENT_NAME);
  });
});
