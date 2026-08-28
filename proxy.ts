import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildContentSecurityPolicy } from './lib/securityHeaders';
import { observeMonitoringLatency } from './lib/monitoring';

function isHttps(req: NextRequest) {
  const forwardedProto = req.headers.get('x-forwarded-proto');

  if (forwardedProto) {
    return forwardedProto.includes('https');
  }

  return req.nextUrl.protocol === 'https:';
}

export default async function middleware(req: NextRequest) {
  const startedAt = Date.now();

  if (process.env.NODE_ENV === 'production' && !isHttps(req)) {
    const url = req.nextUrl.clone();
    url.protocol = 'https';

    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();

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
    buildContentSecurityPolicy(req.nextUrl.pathname, process.env.NODE_ENV)
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
