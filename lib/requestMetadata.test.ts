import { describe, expect, it } from 'vitest';
import { getRateLimitClientKey, getTrustedClientIp, isHttpsRequestMetadata } from './requestMetadata';

describe('trusted request metadata', () => {
  it('uses the right-most address supplied by Azure Container Apps', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.5, 198.51.100.20' });
    expect(getTrustedClientIp(headers, { TRUSTED_PROXY_PROVIDER: 'azure-container-apps' })).toBe('198.51.100.20');
  });

  it('prefers the Vercel-controlled forwarded address', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.8',
      'x-vercel-forwarded-for': '198.51.100.30',
    });
    expect(getTrustedClientIp(headers, { TRUSTED_PROXY_PROVIDER: 'vercel' })).toBe('198.51.100.30');
  });

  it('ignores a caller-supplied X-Forwarded-For when Vercel metadata is absent', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.8' });
    expect(getTrustedClientIp(headers, { TRUSTED_PROXY_PROVIDER: 'vercel' })).toBe('');
  });

  it('does not trust caller-controlled IP headers behind an unknown production proxy', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.8' });
    expect(getTrustedClientIp(headers, { NODE_ENV: 'production' })).toBe('');
    expect(getRateLimitClientKey(headers, { NODE_ENV: 'production' })).toBe('untrusted-proxy');
  });

  it('accepts only an exact normalized HTTPS protocol', () => {
    expect(isHttpsRequestMetadata('https', 'http:')).toBe(true);
    expect(isHttpsRequestMetadata(' HTTPS ', 'http:')).toBe(true);
    expect(isHttpsRequestMetadata('nothttps', 'https:')).toBe(false);
    expect(isHttpsRequestMetadata('https,http', 'https:')).toBe(false);
    expect(isHttpsRequestMetadata(null, 'https:')).toBe(true);
  });
});
