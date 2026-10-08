import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildContentSecurityPolicy, buildCspRequestHeaders, createCspNonce } from './lib/securityHeaders';
import { observeMonitoringLatency } from './lib/monitoring';
import { getRateLimitClientKey, isHttpsRequestMetadata } from './lib/requestMetadata';
import { isEdgeOriginRequestAllowed } from './lib/edgeOriginGuard';
import { ensureSlidingWindow } from './lib/rateLimiter';

const API_RATE_LIMIT_WINDOW_SECONDS = 60;
const API_RATE_LIMIT_PER_IP = 120;

function apiRateLimitBucket(pathname: string, method: string, ip: string) {
  const normalizedPath = pathname.replace(/\/[A-Za-z0-9_-]{12,}(?=\/|$)/g, '/:id');
  return `${method}:${normalizedPath}:${ip}`;
}

export function isHttps(req: NextRequest) {
  return isHttpsRequestMetadata(req.headers.get('x-forwarded-proto'), req.nextUrl.protocol);
}

export default async function middleware(req: NextRequest) {
  const startedAt = Date.now();

  if (!isEdgeOriginRequestAllowed(req.nextUrl.pathname, req.headers)) {
    return NextResponse.json({ error: 'Direct origin access is not allowed.' }, { status: 403 });
  }

  if (req.nextUrl.pathname.startsWith('/api/') && !['/api/live', '/api/ready'].includes(req.nextUrl.pathname) && req.method !== 'OPTIONS') {
    const rateLimit = await ensureSlidingWindow(
      apiRateLimitBucket(req.nextUrl.pathname, req.method, getRateLimitClientKey(req.headers)),
      API_RATE_LIMIT_PER_IP,
      API_RATE_LIMIT_WINDOW_SECONDS,
      'rl:api-path',
      { requireDistributed: process.env.NODE_ENV === 'production' || process.env.REQUIRE_RATE_LIMIT_REDIS === 'true' },
    );
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: rateLimit.unavailable ? 'API rate limiting is temporarily unavailable.' : 'Too many requests. Please try again later.', code: rateLimit.unavailable ? 'rate_limiter_unavailable' : 'rate_limit_exceeded' },
        { status: rateLimit.unavailable ? 503 : 429, headers: rateLimit.retryAfterSec ? { 'Retry-After': String(Math.ceil(rateLimit.retryAfterSec)), 'Cache-Control': 'no-store' } : { 'Cache-Control': 'no-store' } },
      );
    }
  }

  if (process.env.NODE_ENV === 'production' && !isHttps(req)) {
    const url = req.nextUrl.clone();
    url.protocol = 'https';

    return NextResponse.redirect(url);
  }

  const nonce = createCspNonce();
  const environment = process.env.NODE_ENV ?? 'development';
  const contentSecurityPolicy = buildContentSecurityPolicy(req.nextUrl.pathname, environment, nonce);
  const requestHeaders = buildCspRequestHeaders(req.headers, req.nextUrl.pathname, environment, nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set(
    'Referrer-Policy',
    req.nextUrl.pathname.startsWith('/auth/') ? 'no-referrer' : 'strict-origin-when-cross-origin'
  );
  if (req.nextUrl.pathname.startsWith('/auth/')) {
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=()'
  );
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );
  response.headers.set(
    'Content-Security-Policy',
    contentSecurityPolicy
  );
  response.headers.set(
    'Cross-Origin-Opener-Policy',
    'same-origin'
  );
  response.headers.set(
    'Cross-Origin-Resource-Policy',
    'same-origin'
  );

  observeMonitoringLatency(
    'api',
    Date.now() - startedAt,
    { route: req.nextUrl.pathname }
  );

  return response;
}

export const config = {
  matcher: [
    '/api/:path*',
    '/((?!_next|_static|favicon.ico).*)',
  ],
};
