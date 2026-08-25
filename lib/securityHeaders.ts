const DEFAULT_ALLOWED_ORIGINS = [
  'https://localhost:3000',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://10.0.0.7:3000',
  'http://localhost:8082',
  'http://127.0.0.1:8082',
  'http://10.0.0.7:8082',
];

const DEFAULT_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';";

function normalizeAllowedOrigins() {
  const configured = process.env.ALLOWED_ORIGINS?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
}

export function isAllowedOrigin(origin: string | null | undefined) {
  if (!origin) return false;
  const allowedOrigins = normalizeAllowedOrigins();
  return allowedOrigins.includes(origin);
}

export function buildContentSecurityPolicy(pathname: string, environment = process.env.NODE_ENV ?? 'development') {
  const basePolicy = DEFAULT_CONTENT_SECURITY_POLICY;

  if (pathname === '/billing/checkout') {
    return basePolicy
      .replace("script-src 'self'", "script-src 'self' https://cdn.paddle.com")
      .replace("connect-src 'self' https:", "connect-src 'self' https: https://*.paddle.com")
      .replace("object-src 'none'", "frame-src https://*.paddle.com; object-src 'none'");
  }

  if (environment !== 'production' && pathname === '/dev/simli-test') {
    return basePolicy.replace("connect-src 'self' https:", "connect-src 'self' https: wss://api.simli.ai wss://*.livekit.cloud");
  }

  return basePolicy;
}

export function buildCorsHeaders(origin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}
