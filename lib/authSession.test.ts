import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = {
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
const passwordResetToken = {
  findFirst: vi.fn(),
  updateMany: vi.fn(),
};
const emailActionToken = {
  findFirst: vi.fn(),
  updateMany: vi.fn(),
};
const loginChallenge = {
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
};

vi.mock('./prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (transaction: { session: typeof session; passwordResetToken: typeof passwordResetToken; emailActionToken: typeof emailActionToken; loginChallenge: typeof loginChallenge }) => unknown) => operation({ session, passwordResetToken, emailActionToken, loginChallenge })),
  },
}));

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { consumeEmailActionToken, consumeLoginMfaChallenge, consumePasswordResetToken, detectRefreshContextChange, getRefreshSessionExpiry, hashClientDeviceId, hashToken, hasSessionDeviceMismatch, isRefreshSessionExpired, LoginMfaChallengeContextMismatchError, REFRESH_SESSION_IDLE_TTL_MS, RefreshSessionAlreadyUsedError, rotateRefreshSession } from './authSession';

describe('refresh context signals', () => {
  it('hashes a valid opaque installation identifier and rejects malformed values', () => {
    expect(hashClientDeviceId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(hashToken('f47ac10b-58cc-4372-a567-0e02b2c3d479'));
    expect(hashClientDeviceId('short')).toBeNull();
  });

  it('uses a device mismatch as a hard boundary while allowing legacy sessions to migrate', () => {
    expect(hasSessionDeviceMismatch(hashToken('device-a-device-a'), hashToken('device-a-device-a'))).toBe(false);
    expect(hasSessionDeviceMismatch(hashToken('device-a-device-a'), hashToken('device-b-device-b'))).toBe(true);
    expect(hasSessionDeviceMismatch(null, hashToken('device-a-device-a'))).toBe(false);
  });

  it('detects network and client changes without treating them as authentication failures', () => {
    expect(detectRefreshContextChange({
      previousIpAddress: '198.51.100.10',
      currentIpAddress: '203.0.113.25',
      previousUserAgent: 'okhttp/4.12.0',
      currentUserAgent: 'okhttp/4.13.0',
    })).toEqual({ changed: true, ipChanged: true, userAgentChanged: true });
  });

  it('does not flag a missing context value as a mobile session change', () => {
    expect(detectRefreshContextChange({
      previousIpAddress: '198.51.100.10',
      currentIpAddress: null,
      previousUserAgent: 'okhttp/4.12.0',
      currentUserAgent: 'okhttp/4.12.0',
    })).toEqual({ changed: false, ipChanged: false, userAgentChanged: false });
  });
});

describe('refresh session lifetime', () => {
  it('enforces the rolling idle deadline without exceeding the absolute deadline', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const laterAbsoluteDeadline = new Date(now.getTime() + REFRESH_SESSION_IDLE_TTL_MS * 2);
    expect(getRefreshSessionExpiry(laterAbsoluteDeadline, now).getTime()).toBe(now.getTime() + REFRESH_SESSION_IDLE_TTL_MS);

    const earlierAbsoluteDeadline = new Date(now.getTime() + 60_000);
    expect(getRefreshSessionExpiry(earlierAbsoluteDeadline, now)).toEqual(earlierAbsoluteDeadline);
  });

  it('rejects either an idle-expired or absolutely-expired session', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    expect(isRefreshSessionExpired({ expiresAt: new Date(now.getTime() - 1), absoluteExpiresAt: new Date(now.getTime() + 60_000) }, now)).toBe(true);
    expect(isRefreshSessionExpired({ expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() - 1) }, now)).toBe(true);
    expect(isRefreshSessionExpired({ expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 120_000) }, now)).toBe(false);
  });
});

describe('rotateRefreshSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows only one concurrent rotation to claim a refresh session', async () => {
    let claimed = false;
    session.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    session.create.mockResolvedValue({ id: 'replacement-session' });
    session.update.mockResolvedValue({ id: 'old-session' });

    const input = {
      sessionId: 'old-session',
      userId: 'user-1',
      rotatedToken: 'new-refresh-token',
      expiresAt: new Date(Date.now() + 60_000),
      familyId: 'family-1',
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    };
    const results = await Promise.allSettled([
      rotateRefreshSession(input),
      rotateRefreshSession(input),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({ reason: expect.any(RefreshSessionAlreadyUsedError) });
    expect(session.create).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith({
      where: { id: 'old-session' },
      data: { replacedBySessionId: 'replacement-session' },
    });
  });
});

describe('one-time authentication token consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims a password-reset token atomically so replay gets no record', async () => {
    let claimed = false;
    const record = { id: 'reset-1', userId: 'user-1', user: { id: 'user-1' } };
    passwordResetToken.findFirst.mockResolvedValue(record);
    passwordResetToken.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });

    const results = await Promise.all([
      consumePasswordResetToken('reset-token'),
      consumePasswordResetToken('reset-token'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(passwordResetToken.updateMany).toHaveBeenCalledTimes(2);
  });

  it('keeps email verification tokens single-use under replay', async () => {
    let claimed = false;
    const record = { id: 'email-1', userId: 'user-1', user: { id: 'user-1' } };
    emailActionToken.findFirst.mockResolvedValue(record);
    emailActionToken.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });

    const results = await Promise.all([
      consumeEmailActionToken('verification-token', 'VERIFY_EMAIL'),
      consumeEmailActionToken('verification-token', 'VERIFY_EMAIL'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(emailActionToken.updateMany).toHaveBeenCalledTimes(2);
  });

  it('rejects expired or already-used MFA challenges', async () => {
    loginChallenge.findFirst.mockResolvedValue(null);

    await expect(consumeLoginMfaChallenge('challenge-token', '123456')).resolves.toBeNull();

    expect(loginChallenge.update).not.toHaveBeenCalled();
    expect(loginChallenge.updateMany).not.toHaveBeenCalled();
  });

  it('allows only one successful MFA challenge consumption under replay', async () => {
    let claimed = false;
    loginChallenge.findFirst.mockResolvedValue({
      id: 'challenge-1',
      codeHash: hashToken('123456'),
      attempts: 0,
      user: { id: 'user-1', accountStatus: 'ACTIVE', emailVerified: true },
    });
    loginChallenge.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });

    const results = await Promise.all([
      consumeLoginMfaChallenge('challenge-token', '123456'),
      consumeLoginMfaChallenge('challenge-token', '123456'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(loginChallenge.updateMany).toHaveBeenCalledTimes(2);
  });

  it('rejects an MFA code presented from a different bound device', async () => {
    loginChallenge.findFirst.mockResolvedValue({
      id: 'challenge-2',
      userId: 'user-1',
      codeHash: hashToken('123456'),
      deviceIdHash: hashToken('device-a-device-a'),
      attempts: 0,
      user: { id: 'user-1', accountStatus: 'ACTIVE', emailVerified: true },
    });

    await expect(consumeLoginMfaChallenge('challenge-token', '123456', hashToken('device-b-device-b')))
      .rejects.toBeInstanceOf(LoginMfaChallengeContextMismatchError);
    expect(loginChallenge.updateMany).not.toHaveBeenCalled();
  });
});
