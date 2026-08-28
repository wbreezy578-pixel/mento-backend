import { isIP } from 'node:net';

export type TrustedProxyProvider = 'azure-container-apps' | 'vercel' | 'development' | 'none';

function normalizeIp(value: string | null | undefined): string {
  const candidate = value?.trim() ?? '';
  return isIP(candidate) ? candidate : '';
}

function forwardedAddresses(headers: Headers): string[] {
  return (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((value) => normalizeIp(value))
    .filter(Boolean);
}

export function resolveTrustedProxyProvider(environment: NodeJS.ProcessEnv = process.env): TrustedProxyProvider {
  const configured = environment.TRUSTED_PROXY_PROVIDER?.trim().toLowerCase();
  if (configured === 'azure' || configured === 'azure-container-apps') return 'azure-container-apps';
  if (configured === 'vercel') return 'vercel';
  if (configured === 'none') return 'none';
  if (environment.VERCEL === '1') return 'vercel';
  if (environment.CONTAINER_APP_ENV_DNS_SUFFIX || environment.CONTAINER_APP_NAME) return 'azure-container-apps';
  return environment.NODE_ENV === 'production' ? 'none' : 'development';
}

export function getTrustedClientIp(headers: Headers, environment: NodeJS.ProcessEnv = process.env): string {
  const provider = resolveTrustedProxyProvider(environment);
  const forwarded = forwardedAddresses(headers);

  if (provider === 'vercel') {
    const vercelForwarded = (headers.get('x-vercel-forwarded-for') ?? '')
      .split(',')
      .map((value) => normalizeIp(value))
      .find(Boolean);
    return vercelForwarded || forwarded[0] || '';
  }

  if (provider === 'azure-container-apps') {
    // Azure appends its trusted client address after caller-supplied values.
    return forwarded.at(-1) || '';
  }

  if (provider === 'development') {
    return normalizeIp(headers.get('x-real-ip')) || forwarded[0] || '';
  }

  return '';
}

export function getRateLimitClientKey(headers: Headers, environment: NodeJS.ProcessEnv = process.env): string {
  return getTrustedClientIp(headers, environment) || 'untrusted-proxy';
}

export function isHttpsRequestMetadata(forwardedProto: string | null, requestProtocol: string): boolean {
  if (forwardedProto !== null) return forwardedProto.trim().toLowerCase() === 'https';
  return requestProtocol.toLowerCase() === 'https:';
}
