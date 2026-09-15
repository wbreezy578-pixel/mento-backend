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

vi.mock('./prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (transaction: { session: typeof session; passwordResetToken: typeof passwordResetToken; emailActionToken: typeof emailActionToken }) => unknown) => operation({ session, passwordResetToken, emailActionToken })),
  },
}));

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { consumeEmailActionToken, consumePasswordResetToken, getRefreshSessionExpiry, isRefreshSessionExpired, REFRESH_SESSION_IDLE_TTL_MS, RefreshSessionAlreadyUsedError, rotateRefreshSession } from './authSession';

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
});
