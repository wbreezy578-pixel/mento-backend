import { afterEach, describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  buildCorsHeaders,
  buildCspRequestHeaders,
  createCspNonce,
  isAllowedOrigin,
  isValidCspNonce,
} from '../../lib/securityHeaders';

const TEST_NONCE = '0123456789abcdef0123456789abcdef';

describe('web security headers', () => {
  const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
  });

  it('allows only configured CORS origins', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';
    expect(isAllowedOrigin('https://app.example.com')).toBe(true);
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(buildCorsHeaders('https://app.example.com')['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(buildCorsHeaders('https://evil.example.com')['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('keeps local development origins available by default', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(buildCorsHeaders('http://10.0.0.7:8082')['Access-Control-Allow-Origin']).toBe('http://10.0.0.7:8082');
  });

  it('builds a strict nonce-based production policy', () => {
    const policy = buildContentSecurityPolicy('/', 'production', TEST_NONCE);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain(`script-src 'self' 'nonce-${TEST_NONCE}' 'strict-dynamic'`);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('connect-src *');
    expect(policy).not.toContain('connect-src https:');
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('keeps unsafe-eval development-only and does not leak development websocket sources to production', () => {
    const development = buildContentSecurityPolicy('/dev/simli-test', 'development', TEST_NONCE);
    const production = buildContentSecurityPolicy('/dev/simli-test', 'production', TEST_NONCE);
    expect(development).toContain("'unsafe-eval'");
    expect(development).toContain('wss://api.simli.ai');
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).not.toContain('wss://api.simli.ai');
    expect(production).not.toContain('wss://*.livekit.cloud');
  });

  it('allows Paddle browser resources only on the executable checkout page', () => {
    const checkout = buildContentSecurityPolicy('/billing/checkout', 'production', TEST_NONCE);
    const ordinaryPage = buildContentSecurityPolicy('/billing/success', 'production', TEST_NONCE);
    expect(checkout).toContain('https://cdn.paddle.com');
    expect(checkout).toContain('frame-src https://*.paddle.com');
    expect(checkout).toContain("connect-src 'self' https://*.paddle.com");
    expect(ordinaryPage).not.toContain('paddle.com');
  });

  it('keeps inline-style compatibility separate from script execution', () => {
    const policy = buildContentSecurityPolicy('/auth/reset-password', 'production', TEST_NONCE);
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('creates unpredictable per-request nonces', () => {
    const first = createCspNonce();
    const second = createCspNonce();
    expect(isValidCspNonce(first)).toBe(true);
    expect(isValidCspNonce(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('rejects missing or malformed nonces', () => {
    expect(() => buildContentSecurityPolicy('/', 'production', '')).toThrow(/nonce/i);
    expect(() => buildContentSecurityPolicy('/', 'production', 'attacker<script>')).toThrow(/nonce/i);
  });

  it('overwrites client-supplied nonce and CSP request headers with server values', () => {
    const incoming = new Headers({
      'x-nonce': 'client-controlled-nonce',
      'Content-Security-Policy': "script-src * 'unsafe-inline'",
    });
    const headers = buildCspRequestHeaders(incoming, '/', 'production', TEST_NONCE);
    expect(headers.get('x-nonce')).toBe(TEST_NONCE);
    expect(headers.get('Content-Security-Policy')).toBe(buildContentSecurityPolicy('/', 'production', TEST_NONCE));
  });
});
