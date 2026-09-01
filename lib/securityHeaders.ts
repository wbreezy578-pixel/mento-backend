const DEFAULT_ALLOWED_ORIGINS = [
  'https://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://10.0.0.7:3000',
  'http://localhost:8082',
  'http://127.0.0.1:8082',
  'http://10.0.0.7:8082',
];

const CSP_NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/;
const PADDLE_SCRIPT_ORIGIN = 'https://cdn.paddle.com';
const PADDLE_BROWSER_ORIGIN = 'https://*.paddle.com';

function normalizeAllowedOrigins() {
  const configured = process.env.ALLOWED_ORIGINS?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
}

export function isAllowedOrigin(origin: string | null | undefined) {
  if (!origin) return false;
  const allowedOrigins = normalizeAllowedOrigins();
  return allowedOrigins.includes(origin);
}

export function createCspNonce(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export function isValidCspNonce(nonce: string): boolean {
  return CSP_NONCE_PATTERN.test(nonce);
}

export function buildContentSecurityPolicy(
  pathname: string,
  environment: string = process.env.NODE_ENV ?? 'development',
  nonce: string,
) {
  if (!isValidCspNonce(nonce)) {
    throw new Error('A valid server-generated CSP nonce is required.');
  }

  const isDevelopment = environment !== 'production';
  const isCheckout = pathname === '/billing/checkout';
  const isSimliDevelopmentPage = isDevelopment && pathname === '/dev/simli-test';

  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
    ...(isCheckout ? [PADDLE_SCRIPT_ORIGIN] : []),
  ];
  const connectSources = [
    "'self'",
    ...(isDevelopment ? ['ws:', 'wss:'] : []),
    ...(isCheckout ? [PADDLE_BROWSER_ORIGIN] : []),
    ...(isSimliDevelopmentPage ? ['wss://api.simli.ai', 'wss://*.livekit.cloud'] : []),
  ];

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    // Current web pages use React style attributes. Keep this style-only
    // exception separate from script execution until those styles move to CSS.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "media-src 'self'",
    "worker-src 'self'",
    isCheckout ? `frame-src ${PADDLE_BROWSER_ORIGIN}` : "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
    ...(environment === 'production' ? ['upgrade-insecure-requests'] : []),
  ];

  return `${directives.join('; ')};`;
}

export function buildCspRequestHeaders(
  incomingHeaders: Headers,
  pathname: string,
  environment: string,
  nonce: string,
): Headers {
  const requestHeaders = new Headers(incomingHeaders);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', buildContentSecurityPolicy(pathname, environment, nonce));
  return requestHeaders;
}

export function buildCorsHeaders(origin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}
