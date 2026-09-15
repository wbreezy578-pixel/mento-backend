import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildContentSecurityPolicy, buildCspRequestHeaders, createCspNonce } from './lib/securityHeaders';
import { observeMonitoringLatency } from './lib/monitoring';
import { isHttpsRequestMetadata } from './lib/requestMetadata';

export function isHttps(req: NextRequest) {
  return isHttpsRequestMetadata(req.headers.get('x-forwarded-proto'), req.nextUrl.protocol);
}

export default async function middleware(req: NextRequest) {
  const startedAt = Date.now();

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
