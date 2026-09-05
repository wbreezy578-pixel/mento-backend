import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class TestRefreshSessionAlreadyUsedError extends Error {
    constructor() {
      super('Refresh session has already been rotated or revoked.');
      this.name = 'RefreshSessionAlreadyUsedError';
    }
  }

  return {
    getClientIp: vi.fn(() => '198.51.100.10'),
    getSessionClientIp: vi.fn(() => '198.51.100.10'),
    recordSecurityEvent: vi.fn(),
    signToken: vi.fn(() => 'access-token'),
    buildUserSummary: vi.fn((user: unknown) => user),
    applyAuthCookies: vi.fn(),
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
  applyAuthCookies: mocks.applyAuthCookies,
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));
vi.mock('../../../lib/authSession', () => ({
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
  absoluteExpiresAt: new Date('2099-02-01T00:00:00.000Z'),
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  user,
};

function refreshRequest() {
  return new Request('https://auth.trymentoapp.com/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'refresh-token' }),
  });
}

describe('refresh-session race and reuse handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('never returns provider or database details for a refresh failure', async () => {
    mocks.findSessionByToken.mockRejectedValue(new Error('database password=secret'));
    const response = await POST(refreshRequest());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Unable to refresh session' });
  });
});
