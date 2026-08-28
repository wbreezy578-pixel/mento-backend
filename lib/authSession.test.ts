import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = {
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

vi.mock('./prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (transaction: { session: typeof session }) => unknown) => operation({ session })),
  },
}));

vi.mock('./logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getRefreshSessionExpiry, isRefreshSessionExpired, REFRESH_SESSION_IDLE_TTL_MS, RefreshSessionAlreadyUsedError, rotateRefreshSession } from './authSession';

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
