import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class TestLoginMfaChallengeContextMismatchError extends Error {
    constructor(public readonly userId: string) {
      super('Login MFA challenge was presented from a different device.');
      this.name = 'LoginMfaChallengeContextMismatchError';
    }
  }

  return {
  consumeLoginMfaChallenge: vi.fn(),
  createSessionRecord: vi.fn(),
  createNotification: vi.fn(async () => null),
  generateSecureToken: vi.fn(() => 'refresh-token'),
  getRefreshSessionExpiry: vi.fn(() => new Date('2099-01-01T00:00:00.000Z')),
  recordSecurityEvent: vi.fn(),
  resetFailedLoginAttempts: vi.fn(),
  signToken: vi.fn(() => 'access-token'),
  buildAuthSessionResponseBody: vi.fn((input: Record<string, unknown>) => ({
    token: input.accessToken,
    refreshToken: input.refreshToken,
    sessionExpiresAt: input.sessionExpiresAt,
    user: input.user,
  })),
  buildUserSummary: vi.fn((user: unknown) => user),
  applyAuthCookies: vi.fn(),
  isBrowserAuthRequest: vi.fn(() => false),
  getSessionClientIp: vi.fn(() => '198.51.100.10'),
  authRateLimitSubject: vi.fn((value: string) => `subject:${value}`),
  ensureSlidingWindow: vi.fn(async () => ({ ok: true })),
  hashClientDeviceId: vi.fn((value: string | null) => value ? `device-hash:${value}` : null),
  LoginMfaChallengeContextMismatchError: TestLoginMfaChallengeContextMismatchError,
};
});

vi.mock('../../../../lib/authSession', () => ({
  consumeLoginMfaChallenge: mocks.consumeLoginMfaChallenge,
  createSessionRecord: mocks.createSessionRecord,
  generateSecureToken: mocks.generateSecureToken,
  getRefreshSessionExpiry: mocks.getRefreshSessionExpiry,
  hashClientDeviceId: mocks.hashClientDeviceId,
  LoginMfaChallengeContextMismatchError: mocks.LoginMfaChallengeContextMismatchError,
  REFRESH_SESSION_ABSOLUTE_TTL_MS: 90 * 24 * 60 * 60 * 1000,
}));
vi.mock('../../../lib/auth', () => ({
  buildUserSummary: mocks.buildUserSummary,
  applyAuthCookies: mocks.applyAuthCookies,
  buildAuthSessionResponseBody: mocks.buildAuthSessionResponseBody,
  isBrowserAuthRequest: mocks.isBrowserAuthRequest,
  getSessionClientIp: mocks.getSessionClientIp,
  authRateLimitSubject: mocks.authRateLimitSubject,
  resetFailedLoginAttempts: mocks.resetFailedLoginAttempts,
  recordSecurityEvent: mocks.recordSecurityEvent,
  signToken: mocks.signToken,
}));
vi.mock('../../../services/notificationService', () => ({ createNotification: mocks.createNotification }));
vi.mock('../../../../lib/securityHeaders', () => ({ buildCorsHeaders: () => ({}) }));
vi.mock('../../../../lib/rateLimiter', () => ({ ensureSlidingWindow: mocks.ensureSlidingWindow }));

import { POST } from './route';

const challenge = {
  user: {
    id: 'user-1',
    email: 'learner@example.com',
    emailVerified: true,
    accountStatus: 'ACTIVE',
  },
};

function request(headers: Record<string, string> = {}) {
  return new Request('https://auth.trymentoapp.com/api/login/verify-mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.12.0', 'X-Mento-Device-Id': 'device-a', ...headers },
    body: JSON.stringify({ challengeToken: 'a'.repeat(64), code: '123456' }),
  });
}

describe('MFA verification session safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSlidingWindow.mockResolvedValue({ ok: true });
    mocks.createSessionRecord.mockResolvedValue({ id: 'session-1' });
  });

  it('does not create a session for an expired or already-used challenge', async () => {
    mocks.consumeLoginMfaChallenge.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(mocks.createSessionRecord).not.toHaveBeenCalled();
  });

  it('creates only one session when the same challenge is submitted concurrently', async () => {
    let consumed = false;
    mocks.consumeLoginMfaChallenge.mockImplementation(async () => {
      if (consumed) return null;
      consumed = true;
      return challenge;
    });

    const responses = await Promise.all([POST(request()), POST(request())]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(mocks.createSessionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not create a session when a challenge is presented from another device', async () => {
    mocks.consumeLoginMfaChallenge.mockRejectedValue(new mocks.LoginMfaChallengeContextMismatchError('user-1'));

    const response = await POST(request({ 'X-Mento-Device-Id': 'device-b' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'That sign-in code is invalid or expired.' });
    expect(mocks.createSessionRecord).not.toHaveBeenCalled();
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith('user-1', 'mfa_challenge_device_mismatch', { deviceIdProvided: true });
  });
});
