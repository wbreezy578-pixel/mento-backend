import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFreeWebsTestingUsage, isWebsTestingMode, resolveWebsUserCharge } from './websiteTestingMode';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Blue Webs testing mode', () => {
  it('enables only when both the test flag and Blue backend identity are set', () => {
    vi.stubEnv('MENTO_BACKEND_ENV', 'blue');
    vi.stubEnv('WEBS_TEST_MODE', 'true');
    expect(isWebsTestingMode()).toBe(true);

    vi.stubEnv('MENTO_BACKEND_ENV', 'production');
    expect(isWebsTestingMode).toThrow('only be enabled on the isolated Blue backend');
  });

  it('does not enable when the test flag is false', () => {
    vi.stubEnv('MENTO_BACKEND_ENV', 'blue');
    vi.stubEnv('WEBS_TEST_MODE', 'false');
    expect(isWebsTestingMode()).toBe(false);
  });

  it('waives usage charges only for website-source website and image requests', () => {
    vi.stubEnv('MENTO_BACKEND_ENV', 'blue');
    vi.stubEnv('WEBS_TEST_MODE', 'true');
    expect(isFreeWebsTestingUsage('website', { source: 'websites' })).toBe(true);
    expect(isFreeWebsTestingUsage('image', { source: 'websites' })).toBe(true);
    expect(isFreeWebsTestingUsage('image', { source: 'profile-photo' })).toBe(false);
    expect(isFreeWebsTestingUsage('chat', { source: 'websites' })).toBe(false);
    expect(resolveWebsUserCharge('website', { source: 'websites' }, 1.25)).toBe(0);
    expect(resolveWebsUserCharge('chat', { source: 'websites' }, 1.25)).toBe(1.25);
  });
});
