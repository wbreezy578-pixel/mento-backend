import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  websiteFindFirst: vi.fn(),
  getWebsiteHostingState: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: { website: { findFirst: mocks.websiteFindFirst } },
}));
vi.mock('./websiteBillingService', () => ({
  getWebsiteHostingState: mocks.getWebsiteHostingState,
}));

import { buildStableWebsiteQrUrl, getPublishedWebsiteQrTarget } from './websiteQrService';

describe('stable published website QR links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a permanent Mento resolver URL based on the project ID', () => {
    expect(buildStableWebsiteQrUrl('website_123')).toBe('https://api.trymentoapp.com/api/websites/qr/website_123');
    expect(() => buildStableWebsiteQrUrl('../auth')).toThrow(/cannot be used/);
  });

  it('resolves only live published sites with an active Mento hostname and hosting', async () => {
    mocks.websiteFindFirst.mockResolvedValueOnce({
      id: 'website-1',
      title: 'Bella Restaurant',
      type: 'restaurant',
      domains: [{ hostname: 'web-bella.trymentoapp.com' }],
    });
    mocks.getWebsiteHostingState.mockResolvedValueOnce({ status: 'active' });

    await expect(getPublishedWebsiteQrTarget('website-1')).resolves.toEqual({
      id: 'website-1',
      title: 'Bella Restaurant',
      type: 'restaurant',
      hostname: 'web-bella.trymentoapp.com',
      destinationUrl: 'https://web-bella.trymentoapp.com/',
      qrUrl: 'https://api.trymentoapp.com/api/websites/qr/website-1',
    });
    expect(mocks.websiteFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'website-1',
        status: 'published',
        deletedAt: null,
        publishedVersion: { not: null },
        publishedDeploymentId: { not: null },
      }),
    }));
  });

  it('does not resolve suspended, malformed, or unpublished projects', async () => {
    await expect(getPublishedWebsiteQrTarget('../auth')).resolves.toBeNull();
    expect(mocks.websiteFindFirst).not.toHaveBeenCalled();

    mocks.websiteFindFirst.mockResolvedValueOnce({
      id: 'website-2',
      title: 'Unavailable',
      type: 'business',
      domains: [{ hostname: 'auth.trymentoapp.com' }],
    });
    await expect(getPublishedWebsiteQrTarget('website-2')).resolves.toBeNull();
    expect(mocks.getWebsiteHostingState).not.toHaveBeenCalled();

    mocks.websiteFindFirst.mockResolvedValueOnce({
      id: 'website-3',
      title: 'Suspended',
      type: 'restaurant',
      domains: [{ hostname: 'web-suspended.trymentoapp.com' }],
    });
    mocks.getWebsiteHostingState.mockResolvedValueOnce({ status: 'suspended' });
    await expect(getPublishedWebsiteQrTarget('website-3')).resolves.toBeNull();
  });
});
