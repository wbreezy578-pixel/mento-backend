import { NextResponse } from 'next/server';
import { ensureSlidingWindow } from '../../../../../lib/rateLimiter';
import { AIRequestGatewayError, authenticateAIRequest } from '../../../../../lib/aiSecurityGateway';
import { readJsonBodyWithLimit, RequestBodyError } from '../../../../../lib/requestBody';
import { buildCorsHeaders } from '../../../../../lib/securityHeaders';
import logger from '../../../../../lib/logger';
import { assertWebsiteFeatureAccess, WebsiteAccessError } from '../../../../../services/websiteBillingService';
import { isWebsTestingMode } from '../../../../../services/websiteTestingMode';
import { searchUnsplashImages, UnsplashSearchError, type UnsplashOrientation } from '../../../../../services/unsplashService';
import { isWebsiteType } from '../../../../../services/websiteContent';
import { parseWebsiteDesignPreferences } from '../../../../../services/websiteDesignPreferences';
import { buildWebsitePhotoSearchQuery } from '../../../../../services/websitePhotoSearch';

const MAX_BODY_BYTES = 2 * 1024;
const SEARCH_LIMIT_PER_MINUTE = 10;
const SEARCH_WINDOW_SECONDS = 60;
const UNSPLASH_ATTRIBUTION_URL = 'https://unsplash.com/?utm_source=mento&utm_medium=referral';
const orientations = new Set<UnsplashOrientation>(['landscape', 'portrait', 'square', 'any']);

function headers(req: Request) {
  return { ...buildCorsHeaders(req.headers.get('origin')), 'Cache-Control': 'no-store, private' };
}

function retryHeaders(retryAfterSec: number | undefined): Record<string, string> {
  return retryAfterSec ? { 'Retry-After': String(Math.ceil(retryAfterSec)) } : {};
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...buildCorsHeaders(req.headers.get('origin')), 'Access-Control-Allow-Methods': 'POST, OPTIONS' },
  });
}

export async function POST(req: Request) {
  try {
    const user = await authenticateAIRequest(req);
    if (!isWebsTestingMode()) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404, headers: headers(req) });
    }
    const body = await readJsonBodyWithLimit<{
      query?: unknown;
      page?: unknown;
      perPage?: unknown;
      orientation?: unknown;
      websiteType?: unknown;
      designPreferences?: unknown;
    }>(req, MAX_BODY_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({
        error: 'Provide a valid photo search request.',
        code: 'invalid_photo_search_request',
      }, { status: 400, headers: headers(req) });
    }
    const query = typeof body.query === 'string' ? body.query.trim().replace(/\s+/g, ' ') : '';
    if (!query || query.length > 100) {
      return NextResponse.json({
        error: 'Enter a search phrase of 1 to 100 characters.',
        code: 'invalid_photo_search_query',
      }, { status: 400, headers: headers(req) });
    }
    const hasDesignContext = body.websiteType !== undefined || body.designPreferences !== undefined;
    const websiteType = isWebsiteType(body.websiteType) ? body.websiteType : null;
    const designPreferences = websiteType ? parseWebsiteDesignPreferences(body.designPreferences, websiteType) : null;
    if (hasDesignContext && (!websiteType || !designPreferences)) {
      return NextResponse.json({
        error: 'Choose supported website design options before searching for photos.',
        code: 'invalid_design_preferences',
      }, { status: 400, headers: headers(req) });
    }

    const page = body.page === undefined ? 1 : body.page;
    const perPage = body.perPage === undefined ? 12 : body.perPage;
    const orientation = body.orientation === undefined ? 'landscape' : body.orientation;
    if (
      typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > 100
      || typeof perPage !== 'number' || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 20
      || typeof orientation !== 'string' || !orientations.has(orientation as UnsplashOrientation)
    ) {
      return NextResponse.json({
        error: 'Choose a valid page, result count, and image orientation.',
        code: 'invalid_photo_search_options',
      }, { status: 400, headers: headers(req) });
    }

    const limit = await ensureSlidingWindow(
      user.id,
      SEARCH_LIMIT_PER_MINUTE,
      SEARCH_WINDOW_SECONDS,
      'rl:webs:unsplash',
      { requireDistributed: true },
    );
    if (!limit.ok) {
      const retryAfterSec = limit.retryAfterSec ?? 5;
      return NextResponse.json({
        error: limit.unavailable
          ? 'Photo search is temporarily unavailable. Please try again shortly.'
          : "You're searching too quickly. Please wait a moment.",
        code: limit.unavailable ? 'photo_search_limiter_unavailable' : 'photo_search_rate_limited',
        retryAfterSec,
        retryable: true,
      }, {
        status: limit.unavailable ? 503 : 429,
        headers: { ...headers(req), ...retryHeaders(retryAfterSec) },
      });
    }

    await assertWebsiteFeatureAccess(user.id, 'create');
    const result = await searchUnsplashImages({
      query: buildWebsitePhotoSearchQuery(query, designPreferences ?? undefined),
      page,
      perPage,
      orientation: orientation as UnsplashOrientation,
    });
    return NextResponse.json({
      ...result,
      message: result.results.length ? null : 'No matching photos found. Try different search words.',
      attribution: { label: 'Photos by Unsplash', url: UNSPLASH_ATTRIBUTION_URL },
    }, { headers: headers(req) });
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: headers(req) });
    }
    if (error instanceof AIRequestGatewayError) {
      return NextResponse.json(error.body, { status: error.status, headers: { ...error.headers, ...headers(req) } });
    }
    if (error instanceof WebsiteAccessError) {
      return NextResponse.json({ error: error.message, code: 'website_access_required' }, { status: error.status, headers: headers(req) });
    }
    if (error instanceof UnsplashSearchError) {
      const timeout = error.kind === 'timeout';
      const rateLimited = error.kind === 'demo_rate_limited' || error.kind === 'rate_limited';
      const limiterUnavailable = error.kind === 'rate_limiter_unavailable';
      const retryAfterSec = error.retryAfterSec;
      logger.warn('Unsplash photo search unavailable', {
        category: error.kind,
        ...(error.providerStatus ? { providerStatus: error.providerStatus } : {}),
      });
      return NextResponse.json({
        error: timeout
          ? 'The photo search took too long. Please try again.'
          : rateLimited
            ? 'Photo search has reached its temporary limit. Please try again later.'
            : 'Photo search is temporarily unavailable. Please try again shortly.',
        code: timeout
          ? 'photo_search_timeout'
          : rateLimited ? 'photo_search_rate_limited'
            : limiterUnavailable ? 'photo_search_limiter_unavailable' : 'photo_search_unavailable',
        retryable: true,
        ...(retryAfterSec ? { retryAfterSec } : {}),
      }, {
        status: timeout ? 504 : 503,
        headers: { ...headers(req), ...(retryAfterSec ? retryHeaders(retryAfterSec) : {}) },
      });
    }
    logger.error('Unsplash photo search failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json({
      error: 'Photo search is temporarily unavailable. Please try again shortly.',
      code: 'photo_search_unavailable',
      retryable: true,
    }, { status: 503, headers: headers(req) });
  }
}

export const runtime = 'nodejs';
