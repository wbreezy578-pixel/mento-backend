import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userWallet: { findUnique: vi.fn() },
  website: { count: vi.fn() },
  usageLog: { count: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    userWallet: mocks.userWallet,
    website: mocks.website,
    usageLog: mocks.usageLog,
  },
}));

import { assertWebsiteFeatureAccess, WEBSITE_EDIT_LIMIT_PER_PERIOD, WEBSITE_PROJECT_LIMIT } from './websiteBillingService';

describe('website billing policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires an active Pro subscription before website features are allowed', async () => {
    mocks.userWallet.findUnique.mockResolvedValue({
      userId: 'user-1',
      subscriptionStatus: 'inactive',
      subscriptionExpiresAt: new Date('2024-01-01T00:00:00Z'),
      subscriptionPeriodStart: new Date('2023-12-01T00:00:00Z'),
      plan: { name: 'FREE' },
    });

    await expect(assertWebsiteFeatureAccess('user-1', 'create')).rejects.toThrow('active Mento Pro');
  });

  it('blocks website creation once the Pro project quota is reached', async () => {
    mocks.userWallet.findUnique.mockResolvedValue({
      userId: 'user-1',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: new Date('2099-01-01T00:00:00Z'),
      subscriptionPeriodStart: new Date('2026-10-01T00:00:00Z'),
      plan: { name: 'PRO' },
    });
    mocks.website.count.mockResolvedValue(WEBSITE_PROJECT_LIMIT);

    await expect(assertWebsiteFeatureAccess('user-1', 'create')).rejects.toThrow(`5 website projects`);
  });

  it('blocks website AI edits once the Pro usage quota is reached for the billing period', async () => {
    mocks.userWallet.findUnique.mockResolvedValue({
      userId: 'user-1',
      subscriptionStatus: 'active',
      subscriptionExpiresAt: new Date('2099-01-01T00:00:00Z'),
      subscriptionPeriodStart: new Date('2026-10-01T00:00:00Z'),
      plan: { name: 'PRO' },
    });
    mocks.usageLog.count.mockResolvedValue(WEBSITE_EDIT_LIMIT_PER_PERIOD);

    await expect(assertWebsiteFeatureAccess('user-1', 'edit')).rejects.toThrow(`50 successful website edits`);
  });
});
