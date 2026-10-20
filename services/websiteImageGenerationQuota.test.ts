import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma', () => ({ prisma: {} }));

import {
  getWebsiteImageGenerationMonthStart,
  getWebsiteImageGenerationResetDate,
  WEBSITE_IMAGE_GENERATION_MONTHLY_LIMIT,
  WebsiteImageGenerationQuotaError,
} from './websiteImageGenerationQuota';

describe('website image generation quota calendar', () => {
  it('allows 15 images per user each calendar month', () => {
    expect(WEBSITE_IMAGE_GENERATION_MONTHLY_LIMIT).toBe(15);
  });

  it('uses UTC month boundaries, including year transitions', () => {
    const now = new Date('2026-12-31T23:59:59.999Z');

    expect(getWebsiteImageGenerationMonthStart(now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(getWebsiteImageGenerationResetDate(now).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('exposes the remaining-allowance snapshot when a reservation is rejected', () => {
    const error = new WebsiteImageGenerationQuotaError({
      limit: 15,
      generated: 15,
      remaining: 0,
      resetsAt: '2027-01-01T00:00:00.000Z',
    });

    expect(error.usage).toEqual({
      limit: 15,
      generated: 15,
      remaining: 0,
      resetsAt: '2027-01-01T00:00:00.000Z',
    });
  });
});
