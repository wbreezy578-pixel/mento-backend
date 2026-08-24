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

import { RefreshSessionAlreadyUsedError, rotateRefreshSession } from './authSession';

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
