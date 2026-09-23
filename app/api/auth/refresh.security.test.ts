import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class TestRefreshSessionAlreadyUsedError extends Error {
    constructor() {
      super('Refresh session has already been rotated or revoked.');
      this.name = 'RefreshSessionAlreadyUsedError';
    }
  }

  return {
    detectRefreshContextChange: vi.fn((input: { previousIpAddress?: string | null; currentIpAddress?: string | null; previousUserAgent?: string | null; currentUserAgent?: string | null }) => ({
      changed: Boolean(input.previousIpAddress && input.currentIpAddress && input.previousIpAddress !== input.currentIpAddress)
        || Boolean(input.previousUserAgent && input.currentUserAgent && input.previousUserAgent !== input.currentUserAgent),
      ipChanged: Boolean(input.previousIpAddress && input.currentIpAddress && input.previousIpAddress !== input.currentIpAddress),
      userAgentChanged: Boolean(input.previousUserAgent && input.currentUserAgent && input.previousUserAgent !== input.currentUserAgent),
    })),
    hashClientDeviceId: vi.fn((value: string | null) => value ? `device-hash:${value}` : null),
    hasSessionDeviceMismatch: vi.fn((previous: string | null, current: string | null) => Boolean(previous && previous !== current)),
    getClientIp: vi.fn(() => '198.51.100.10'),
    getSessionClientIp: vi.fn(() => '198.51.100.10'),
    recordSecurityEvent: vi.fn(),
    signToken: vi.fn(() => 'access-token'),
    buildUserSummary: vi.fn((user: unknown) => user),
    buildAuthSessionResponseBody: vi.fn((input: Record<string, unknown>) => input.browserSession ? { sessionExpiresAt: input.sessionExpiresAt, user: input.user } : { token: input.accessToken, refreshToken: input.refreshToken, sessionExpiresAt: input.sessionExpiresAt, user: input.user }),
    applyAuthCookies: vi.fn(),
    createNotification: vi.fn(async () => null),
    getRefreshTokenFromBrowserCookie: vi.fn(() => null),
    isBrowserAuthRequest: vi.fn(() => false),
    findSessionByToken: vi.fn(),
    generateSecureToken: vi.fn(() => 'rotated-refresh-token'),
    getRefreshSessionExpiry: vi.fn(() => new Date('2099-01-02T00:00:00.000Z')),
    isRefreshSessionExpired: vi.fn(() => false),
    revokeSessionFamily: vi.fn(),
    rotateRefreshSession: vi.fn(),
    RefreshSessionAlreadyUsedError: TestRefreshSessionAlreadyUsedError,
    ensureSlidingWindow: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock('../../lib/auth', () => ({
  getClientIp: mocks.getClientIp,
  getSessionClientIp: mocks.getSessionClientIp,
  recordSecurityEvent: mocks.recordSecurityEvent,
  signToken: mocks.signToken,
  buildUserSummary: mocks.buildUserSummary,
  buildAuthSessionResponseBody: mocks.buildAuthSessionResponseBody,
  applyAuthCookies: mocks.applyAuthCookies,
  getRefreshTokenFromBrowserCookie: mocks.getRefreshTokenFromBrowserCookie,
  isBrowserAuthRequest: mocks.isBrowserAuthRequest,
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));
vi.mock('../../services/notificationService', () => ({ createNotification: mocks.createNotification }));
vi.mock('../../../lib/authSession', () => ({
  detectRefreshContextChange: mocks.detectRefreshContextChange,
  hashClientDeviceId: mocks.hashClientDeviceId,
  hasSessionDeviceMismatch: mocks.hasSessionDeviceMismatch,
  findSessionByToken: mocks.findSessionByToken,
  generateSecureToken: mocks.generateSecureToken,
  getRefreshSessionExpiry: mocks.getRefreshSessionExpiry,
  isRefreshSessionExpired: mocks.isRefreshSessionExpired,
  revokeSessionFamily: mocks.revokeSessionFamily,
  rotateRefreshSession: mocks.rotateRefreshSession,
  RefreshSessionAlreadyUsedError: mocks.RefreshSessionAlreadyUsedError,
}));
vi.mock('../../../lib/rateLimiter', () => ({ ensureSlidingWindow: mocks.ensureSlidingWindow }));
vi.mock('../../../lib/securityHeaders', () => ({ buildCorsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.trymentoapp.com' }) }));

import { POST } from './refresh/route';

const user = {
  id: 'user-a',
  email: 'learner@example.com',
  emailVerified: true,
  accountStatus: 'ACTIVE',
};
const session = {
  id: 'session-a',
  userId: 'user-a',
  familyId: 'family-a',
  revokedAt: null,
  replacedBySessionId: null,
  userAgent: 'okhttp/4.12.0',
  ipAddress: '198.51.100.10',
  deviceIdHash: 'device-hash:device-a',
  absoluteExpiresAt: new Date('2099-02-01T00:00:00.000Z'),
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  user,
};

function refreshRequest(headers: Record<string, string> = {}) {
  return new Request('https://auth.trymentoapp.com/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.12.0', 'X-Mento-Device-Id': 'device-a', ...headers },
    body: JSON.stringify({ refreshToken: 'refresh-token' }),
  });
}

describe('refresh-session race and reuse handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClientIp.mockReturnValue('198.51.100.10');
    mocks.getSessionClientIp.mockReturnValue('198.51.100.10');
    mocks.isBrowserAuthRequest.mockReturnValue(false);
    mocks.findSessionByToken.mockResolvedValue(session);
    mocks.rotateRefreshSession.mockResolvedValue({ ...session, id: 'session-b' });
    mocks.revokeSessionFamily.mockResolvedValue(undefined);
  });

  it('returns one replacement and revokes the whole family when the old token is reused', async () => {
    const alreadyUsed = new mocks.RefreshSessionAlreadyUsedError();
    mocks.rotateRefreshSession
      .mockResolvedValueOnce({ ...session, id: 'session-b' })
      .mockRejectedValueOnce(alreadyUsed);

    const first = await POST(refreshRequest());
    const replay = await POST(refreshRequest());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({ error: 'Refresh token expired' });
    expect(mocks.revokeSessionFamily).toHaveBeenCalledWith('family-a');
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith('user-a', 'refresh_token_reuse_detected', expect.objectContaining({ source: 'rotation_race' }));
    expect(mocks.createNotification).toHaveBeenCalledWith('user-a', expect.objectContaining({
      title: 'Session security alert',
      type: 'security',
      category: 'SECURITY',
    }));
  });

  it('never returns provider or database details for a refresh failure', async () => {
    mocks.findSessionByToken.mockRejectedValue(new Error('database password=secret'));
    const response = await POST(refreshRequest());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Unable to refresh session' });
  });

  it('uses an HttpOnly-cookie response shape for an allowed browser session', async () => {
    mocks.isBrowserAuthRequest.mockReturnValue(true);
    const response = await POST(refreshRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessionExpiresAt: '2099-01-01T00:00:00.000Z', user });
    expect(mocks.applyAuthCookies).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ browserSession: true }));
  });

  it('records a changed refresh context without logging out a mobile session', async () => {
    mocks.getSessionClientIp.mockReturnValue('203.0.113.25');

    const response = await POST(refreshRequest({ 'User-Agent': 'okhttp/4.13.0' }));

    expect(response.status).toBe(200);
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith('user-a', 'refresh_context_changed', {
      sessionId: 'session-a',
      familyId: 'family-a',
      ipChanged: true,
      userAgentChanged: true,
    });
    expect(mocks.createNotification).toHaveBeenCalledWith('user-a', expect.objectContaining({
      type: 'security',
      category: 'SECURITY',
    }));
  });

  it('revokes the refresh family when a token is presented from another device', async () => {
    const response = await POST(refreshRequest({ 'X-Mento-Device-Id': 'device-b' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Session security check failed. Please sign in again.' });
    expect(mocks.rotateRefreshSession).not.toHaveBeenCalled();
    expect(mocks.revokeSessionFamily).toHaveBeenCalledWith('family-a');
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith('user-a', 'refresh_device_mismatch', {
      sessionId: 'session-a',
      familyId: 'family-a',
      deviceIdProvided: true,
    });
  });

  it('never includes refresh tokens or raw context values in the security event', async () => {
    mocks.getSessionClientIp.mockReturnValue('203.0.113.25');

    await POST(refreshRequest({ 'User-Agent': 'unexpected-client' }));

    const contextEvent = mocks.recordSecurityEvent.mock.calls.find((call: unknown[]) => call[1] === 'refresh_context_changed');
    expect(contextEvent).toBeDefined();
    expect(JSON.stringify(contextEvent)).not.toContain('refresh-token');
    expect(JSON.stringify(contextEvent)).not.toContain('203.0.113.25');
    expect(JSON.stringify(contextEvent)).not.toContain('unexpected-client');
  });
});
