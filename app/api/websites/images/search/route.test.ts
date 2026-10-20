import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateAIRequest: vi.fn(),
  ensureSlidingWindow: vi.fn(),
  assertWebsiteFeatureAccess: vi.fn(),
  isWebsTestingMode: vi.fn(),
  searchUnsplashImages: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../../../lib/aiSecurityGateway', () => ({
  AIRequestGatewayError: class AIRequestGatewayError extends Error {
    constructor(
      readonly status: number,
      readonly body: unknown,
      readonly headers: Record<string, string> = {},
    ) {
      super('AI request rejected');
    }
  },
  authenticateAIRequest: mocks.authenticateAIRequest,
}));

vi.mock('../../../../../lib/rateLimiter', () => ({ ensureSlidingWindow: mocks.ensureSlidingWindow }));
vi.mock('../../../../../services/websiteBillingService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../services/websiteBillingService')>()),
  assertWebsiteFeatureAccess: mocks.assertWebsiteFeatureAccess,
}));
vi.mock('../../../../../services/websiteTestingMode', () => ({ isWebsTestingMode: mocks.isWebsTestingMode }));
vi.mock('../../../../../services/unsplashService', () => ({
  UnsplashSearchError: class UnsplashSearchError extends Error {
    constructor(readonly kind: string, readonly retryAfterSec?: number) {
      super(kind);
    }
  },
  searchUnsplashImages: mocks.searchUnsplashImages,
}));
vi.mock('../../../../../lib/logger', () => ({
  default: { warn: mocks.loggerWarn, error: mocks.loggerError, info: vi.fn() },
}));

import { AIRequestGatewayError } from '../../../../../lib/aiSecurityGateway';
import { WebsiteAccessError } from '../../../../../services/websiteBillingService';
import { UnsplashSearchError } from '../../../../../services/unsplashService';
import { POST } from './route';

function request(body: unknown) {
  return new Request('https://api.example.test/api/websites/images/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/websites/images/search', () => {
  beforeEach(() => {
    mocks.authenticateAIRequest.mockResolvedValue({ id: 'user-1' });
    mocks.ensureSlidingWindow.mockResolvedValue({ ok: true });
    mocks.assertWebsiteFeatureAccess.mockResolvedValue({ activePro: true });
    mocks.isWebsTestingMode.mockReturnValue(true);
    mocks.searchUnsplashImages.mockResolvedValue({
      results: [{ id: 'photo-1' }],
      total: 1,
      totalPages: 1,
    });
  });

  it('requires a signed-in user and applies the strict shared per-user search limit', async () => {
    const response = await POST(request({ query: 'seafood restaurant' }));
    expect(response.status).toBe(200);
    expect(mocks.ensureSlidingWindow).toHaveBeenCalledWith(
      'user-1',
      10,
      60,
      'rl:webs:unsplash',
      { requireDistributed: true },
    );
    expect(mocks.assertWebsiteFeatureAccess).toHaveBeenCalledWith('user-1', 'create');
  });

  it('returns bounded search results and photo attribution without exposing credentials', async () => {
    const response = await POST(request({
      query: '  seafood   restaurant ',
      page: 2,
      perPage: 8,
      orientation: 'square',
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.searchUnsplashImages).toHaveBeenCalledWith({
      query: 'seafood restaurant',
      page: 2,
      perPage: 8,
      orientation: 'square',
    });
    expect(body.attribution.url).toBe('https://unsplash.com/?utm_source=mento&utm_medium=referral');
    expect(JSON.stringify(body)).not.toContain('access-key');
  });

  it('uses the guided visual brief when searching Unsplash and rejects unsafe style values', async () => {
    const preferences = {
      designPreset: 'coastal-editorial',
      heroImageMode: 'beside',
      backgroundStyle: 'warm',
      overlayStrength: 'strong',
      imageCrop: 'top',
      imageMood: 'natural morning light',
    };
    const response = await POST(request({
      query: 'Nairobi bakery sourdough bread',
      websiteType: 'restaurant',
      designPreferences: preferences,
    }));
    expect(response.status).toBe(200);
    expect(mocks.searchUnsplashImages).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('coastal warm copy space natural morning light'),
    }));

    const invalid = await POST(request({
      query: 'Nairobi bakery sourdough bread',
      websiteType: 'restaurant',
      designPreferences: { ...preferences, heroImageMode: 'url(javascript:alert(1))' },
    }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe('invalid_design_preferences');
  });

  it('rejects missing or overlong queries and out-of-range search options', async () => {
    const missingQuery = await POST(request({ query: '  ' }));
    expect(missingQuery.status).toBe(400);
    expect((await missingQuery.json()).code).toBe('invalid_photo_search_query');

    const overlongQuery = await POST(request({ query: 'a'.repeat(101) }));
    expect(overlongQuery.status).toBe(400);

    const invalidOptions = await POST(request({ query: 'seafood', page: 0, perPage: 50 }));
    expect(invalidOptions.status).toBe(400);
    expect(mocks.searchUnsplashImages).not.toHaveBeenCalled();
    expect(mocks.ensureSlidingWindow).not.toHaveBeenCalled();
  });

  it('enforces search rate limits and fails closed when shared Redis is unavailable', async () => {
    mocks.ensureSlidingWindow.mockResolvedValueOnce({ ok: false, retryAfterSec: 23 });
    const limited = await POST(request({ query: 'seafood' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('23');
    expect((await limited.json()).error).toBe("You're searching too quickly. Please wait a moment.");

    mocks.ensureSlidingWindow.mockResolvedValueOnce({ ok: false, unavailable: true, retryAfterSec: 5 });
    const unavailable = await POST(request({ query: 'seafood' }));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).code).toBe('photo_search_limiter_unavailable');
    expect(mocks.searchUnsplashImages).not.toHaveBeenCalled();
  });

  it('only exposes the endpoint in Blue Webs testing mode', async () => {
    mocks.isWebsTestingMode.mockReturnValue(false);
    const response = await POST(request({ query: 'seafood' }));
    expect(response.status).toBe(404);
    expect(mocks.searchUnsplashImages).not.toHaveBeenCalled();
  });

  it('requires Webs entitlement before calling Unsplash', async () => {
    mocks.assertWebsiteFeatureAccess.mockRejectedValueOnce(new WebsiteAccessError('Website access requires Mento Pro.'));
    const response = await POST(request({ query: 'seafood' }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('website_access_required');
    expect(mocks.searchUnsplashImages).not.toHaveBeenCalled();
  });

  it('maps timeout and provider failures to safe retryable messages', async () => {
    mocks.searchUnsplashImages.mockRejectedValueOnce(new UnsplashSearchError('timeout'));
    const timeout = await POST(request({ query: 'seafood' }));
    expect(timeout.status).toBe(504);
    expect((await timeout.json()).error).toBe('The photo search took too long. Please try again.');

    mocks.searchUnsplashImages.mockRejectedValueOnce(new UnsplashSearchError('provider_unavailable'));
    const providerFailure = await POST(request({ query: 'seafood' }));
    expect(providerFailure.status).toBe(503);
    expect((await providerFailure.json()).error).toBe('Photo search is temporarily unavailable. Please try again shortly.');

    mocks.searchUnsplashImages.mockRejectedValueOnce(new UnsplashSearchError('demo_rate_limited', 240));
    const demoLimit = await POST(request({ query: 'seafood' }));
    expect(demoLimit.status).toBe(503);
    expect(demoLimit.headers.get('retry-after')).toBe('240');
    expect((await demoLimit.json()).code).toBe('photo_search_rate_limited');

    mocks.searchUnsplashImages.mockRejectedValueOnce(new UnsplashSearchError('not_configured'));
    const missingKey = await POST(request({ query: 'seafood' }));
    expect(missingKey.status).toBe(503);
    expect((await missingKey.json()).code).toBe('photo_search_unavailable');
  });

  it('returns authentication errors without attempting provider work', async () => {
    mocks.authenticateAIRequest.mockRejectedValueOnce(new AIRequestGatewayError(401, { error: 'Unauthorized' }));
    const response = await POST(request({ query: 'seafood' }));
    expect(response.status).toBe(401);
    expect(mocks.searchUnsplashImages).not.toHaveBeenCalled();
  });
});
