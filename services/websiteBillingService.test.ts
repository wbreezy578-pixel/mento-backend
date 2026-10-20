import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('website billing policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets the monthly Pro website and AI-edit quotas', () => {
    expect(WEBSITE_PROJECT_LIMIT).toBe(5);
    expect(WEBSITE_EDIT_LIMIT_PER_PERIOD).toBe(15);
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

    await expect(assertWebsiteFeatureAccess('user-1', 'create')).rejects.toThrow(`limit of 5 website creations`);
    expect(mocks.website.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        createdAt: { gte: expect.any(Date), lt: expect.any(Date) },
      },
    });
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

    await expect(assertWebsiteFeatureAccess('user-1', 'edit')).rejects.toThrow(`limit of 15 successful AI edits`);
  });

  it('waives Pro and Webs quotas only in Blue testing mode', async () => {
    vi.stubEnv('MENTO_BACKEND_ENV', 'blue');
    vi.stubEnv('WEBS_TEST_MODE', 'true');
    mocks.userWallet.findUnique.mockResolvedValue(null);
    mocks.website.count.mockResolvedValue(WEBSITE_PROJECT_LIMIT);
    mocks.usageLog.count.mockResolvedValue(WEBSITE_EDIT_LIMIT_PER_PERIOD);

    const snapshot = await assertWebsiteFeatureAccess('user-1', 'create');

    expect(snapshot.activePro).toBe(false);
    await expect(assertWebsiteFeatureAccess('user-1', 'edit')).resolves.toMatchObject({ activePro: false });
  });
});
