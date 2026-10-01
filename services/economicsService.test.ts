import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: {
    plan: { upsert: vi.fn() },
    userWallet: { upsert: vi.fn(), findUnique: vi.fn() },
    liveTutorWallet: { upsert: vi.fn(), findUnique: vi.fn() },
    usageLog: { count: vi.fn() },
  },
  getPlan: vi.fn(),
  getEffectiveLimit: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('./planService', () => ({
  getPlan: mocks.getPlan,
  getEffectiveLimit: mocks.getEffectiveLimit,
}));

import { ensureUserBillingSetup } from './economicsService';

const PRO_WALLET = {
  id: 'wallet-pro',
  userId: 'user-pro',
  subscriptionStatus: 'active',
  plan: { name: 'PRO' },
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('ensureUserBillingSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.plan.upsert.mockResolvedValue({ id: 'plan-free' });
    mocks.prisma.userWallet.upsert.mockResolvedValue(PRO_WALLET);
    mocks.prisma.userWallet.findUnique.mockResolvedValue(PRO_WALLET);
    mocks.prisma.liveTutorWallet.upsert.mockResolvedValue({
      id: 'live-wallet-pro',
      userId: 'user-pro',
      minutesBalance: 47,
    });
    mocks.prisma.liveTutorWallet.findUnique.mockResolvedValue({
      id: 'live-wallet-pro',
      userId: 'user-pro',
      minutesBalance: 47,
    });
    mocks.prisma.usageLog.count.mockResolvedValue(0);
    mocks.getPlan.mockResolvedValue({ name: 'PRO', messageLimit: null, features: { chatDailyLimit: 120 } });
    mocks.getEffectiveLimit.mockReturnValue(120);
  });

  it('keeps an existing Pro wallet unchanged while ensuring billing records', async () => {
    const wallet = await ensureUserBillingSetup('user-pro');

    expect(mocks.prisma.userWallet.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-pro' },
      update: {},
    }));
    expect(mocks.prisma.userWallet.upsert.mock.calls[0]?.[0]).not.toEqual(expect.objectContaining({
      update: expect.objectContaining({
        subscriptionStatus: 'active',
      }),
    }));
    expect(wallet.plan).toBe('PRO');
    expect(wallet.subscriptionStatus).toBe('active');
    expect(wallet.liveTutorMinutesBalance).toBe(47);
  });
});
