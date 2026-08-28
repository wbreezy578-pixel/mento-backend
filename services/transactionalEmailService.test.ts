import { afterEach, describe, expect, it } from 'vitest';
import { buildAuthWebLink } from './transactionalEmailService';

const originalBaseUrl = process.env.AUTH_WEB_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.AUTH_WEB_BASE_URL;
  else process.env.AUTH_WEB_BASE_URL = originalBaseUrl;
});

describe('transactional auth links', () => {
  it('builds branded HTTPS links and safely encodes the token', () => {
    process.env.AUTH_WEB_BASE_URL = 'https://auth.trymentoapp.com';
    const link = buildAuthWebLink('verify-email', 'token/with+symbols=');

    expect(link).toBe('https://auth.trymentoapp.com/auth/verify-email?token=token%2Fwith%2Bsymbols%3D');
    expect(link.startsWith('mentomobile:')).toBe(false);
  });

  it('rejects missing web configuration instead of sending a broken link', () => {
    delete process.env.AUTH_WEB_BASE_URL;
    expect(() => buildAuthWebLink('reset-password', 'token')).toThrow('AUTH_WEB_BASE_URL is not configured');
  });

  it('rejects non-HTTPS authentication pages', () => {
    process.env.AUTH_WEB_BASE_URL = 'http://auth.example.com';
    expect(() => buildAuthWebLink('verify-email', 'token')).toThrow('AUTH_WEB_BASE_URL must use HTTPS');
  });
});
