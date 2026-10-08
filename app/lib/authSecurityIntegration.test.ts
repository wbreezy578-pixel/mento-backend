import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  findSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    user: { findUnique: mocks.findUser },
    session: { findFirst: mocks.findSession, update: mocks.updateSession },
    securityEvent: { create: vi.fn() },
  },
}));

import { getUserFromRequest } from './auth';

const secret = process.env.JWT_SECRET ?? 'test-jwt-secret-with-sufficient-entropy';
const issuer = process.env.JWT_ISSUER ?? 'mento';
const audience = process.env.JWT_AUDIENCE ?? 'mento';

const activeUser = {
  id: 'user-a',
  email: 'learner@example.com',
  password: '$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
  emailVerified: true,
  accountStatus: 'ACTIVE',
  credentialsChangedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const activeSession = {
  id: 'session-a',
  userId: 'user-a',
  revokedAt: null,
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  absoluteExpiresAt: new Date('2099-02-01T00:00:00.000Z'),
  lastUsedAt: new Date('2099-01-01T00:00:00.000Z'),
};

function signedToken(payload: Record<string, unknown>, signingSecret = secret) {
  return jwt.sign({ sub: 'user-a', email: activeUser.email, sid: 'session-a', type: 'access', ...payload }, signingSecret, {
    algorithm: 'HS256',
    issuer,
    audience,
    expiresIn: 600,
  });
}

function requestWithToken(token: string) {
  return new Request('https://auth.trymentoapp.com/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('authentication credential and account-state boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue(activeUser);
    mocks.findSession.mockResolvedValue(activeSession);
  });

  it('rejects malformed, expired, incorrectly signed, and refresh-type JWTs', async () => {
    const expired = jwt.sign({ sub: 'user-a', email: activeUser.email, sid: 'session-a', type: 'access' }, secret, {
      algorithm: 'HS256', issuer, audience, expiresIn: -1,
    });
    const incorrectlySigned = signedToken({}, 'different-signing-secret');
    const refresh = signedToken({ type: 'refresh' });

    await expect(getUserFromRequest(requestWithToken('not-a-jwt'))).resolves.toBeNull();
    await expect(getUserFromRequest(requestWithToken(expired))).resolves.toBeNull();
    await expect(getUserFromRequest(requestWithToken(incorrectlySigned))).resolves.toBeNull();
    await expect(getUserFromRequest(requestWithToken(refresh))).resolves.toBeNull();
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.findSession).not.toHaveBeenCalled();
  });

  it('accepts a valid access JWT only when its session and account are active', async () => {
    await expect(getUserFromRequest(requestWithToken(signedToken({})))).resolves.toMatchObject({ id: 'user-a' });

    mocks.findUser.mockResolvedValue({ ...activeUser, accountStatus: 'DELETION_PENDING' });
    await expect(getUserFromRequest(requestWithToken(signedToken({})))).resolves.toBeNull();

    mocks.findUser.mockResolvedValue(activeUser);
    mocks.findSession.mockResolvedValue(null);
    await expect(getUserFromRequest(requestWithToken(signedToken({})))).resolves.toBeNull();
  });

  it('rejects a token issued before a credential change', async () => {
    const token = signedToken({ iat: Math.floor(new Date('2026-01-01T00:00:00.000Z').getTime() / 1000) });
    mocks.findUser.mockResolvedValue({ ...activeUser, credentialsChangedAt: new Date('2026-01-02T00:00:00.000Z') });
    await expect(getUserFromRequest(requestWithToken(token))).resolves.toBeNull();
  });
});
