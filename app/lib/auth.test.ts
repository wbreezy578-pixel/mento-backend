import test from 'node:test';
import assert from 'node:assert/strict';
import { NextResponse } from 'next/server';
import * as auth from './auth';
import { sanitizeForLogging } from '../../lib/sanitize';

test('buildAuthCookieOptions applies secure defaults in production', () => {
  const options = auth.buildAuthCookieOptions({ isProduction: true, maxAgeSeconds: 3600, path: '/api/auth' });
  assert.ok(options);

  assert.equal(options?.httpOnly, true);
  assert.equal(options?.sameSite, 'lax');
  assert.equal(options?.secure, true);
  assert.equal(options?.path, '/api/auth');
  assert.equal(options?.maxAge, 3600);
});

test('isTokenExpired detects expired tokens', () => {
  const expired = auth.isTokenExpired(Math.floor(Date.now() / 1000) - 10);
  const active = auth.isTokenExpired(Math.floor(Date.now() / 1000) + 600);

  assert.equal(expired, true);
  assert.equal(active, false);
});

test('getLoginPolicyState blocks locked accounts and exposes remaining lockout time', () => {
  const state = auth.getLoginPolicyState({
    failedLoginAttempts: 5,
    lockedAt: new Date(Date.now() + 60_000),
  });

  assert.equal(state.allowed, false);
  assert.equal(state.reason, 'account_locked');
  assert.ok(state.lockoutRemainingSeconds >= 55);
});

test('getLoginPolicyState allows unlocked accounts with low failure counts', () => {
  const state = auth.getLoginPolicyState({
    failedLoginAttempts: 2,
    lockedAt: null,
  });

  assert.equal(state.allowed, true);
  assert.equal(state.reason, 'allowed');
  assert.equal(state.lockoutRemainingSeconds, 0);
});

test('getClientIp extracts the left-most forwarded address in development mode', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTrustedProxyProvider = process.env.TRUSTED_PROXY_PROVIDER;
  process.env.NODE_ENV = 'development';
  delete process.env.TRUSTED_PROXY_PROVIDER;

  try {
    const request = new Request('https://example.com/api/login', {
      headers: {
        'x-forwarded-for': '198.51.100.10, 10.0.0.1',
      },
    });

    assert.equal(auth.getClientIp(request), '198.51.100.10');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTrustedProxyProvider === undefined) delete process.env.TRUSTED_PROXY_PROVIDER;
    else process.env.TRUSTED_PROXY_PROVIDER = previousTrustedProxyProvider;
  }
});

test('isAdminUser honors explicit admin markers and configured admin emails', () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'admin@example.com';

  try {
    assert.equal(auth.isAdminUser({ email: 'admin@example.com' }), true);
    assert.equal(auth.isAdminUser({ email: 'user@example.com' }), false);
    assert.equal(auth.isAdminUser({ authProvider: 'admin' }), true);
    assert.equal(auth.isAdminUser({ role: 'admin' }), true);
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = previous;
    }
  }
});

test('isBcryptHash detects valid bcrypt hashes', () => {
  assert.equal(auth.isBcryptHash('$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'), true);
  assert.equal(auth.isBcryptHash('$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'), true);
  assert.equal(auth.isBcryptHash('$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhW'), false);
  assert.equal(auth.isBcryptHash('not-a-bcrypt-hash'), false);
});

test('verifyPassword supports bcrypt and rejects legacy raw passwords', async () => {
  const rawPassword = 'TestPassword123!';
  const bcryptHash = await auth.hashPassword(rawPassword);

  assert.equal(await auth.verifyPassword(rawPassword, bcryptHash), true);
  assert.equal(await auth.verifyPassword('wrong-password', bcryptHash), false);
  assert.equal(await auth.verifyPassword(rawPassword, rawPassword), false);
  assert.equal(await auth.verifyPassword('wrong-password', rawPassword), false);
});

test('browser session cookies remain disabled for the mobile-only product', () => {
  const response = NextResponse.json({ ok: true });
  auth.applyAuthCookies(response, {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    isProduction: true,
    browserSession: false,
  });
  assert.equal(response.cookies.get('mento_access_token'), undefined);
  assert.equal(response.cookies.get('mento_refresh_token'), undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('browser sessions require both server enablement and an allowed browser origin', () => {
  const previousEnabled = process.env.AUTH_BROWSER_SIGN_IN_ENABLED;
  const previousOrigins = process.env.ALLOWED_ORIGINS;
  process.env.AUTH_BROWSER_SIGN_IN_ENABLED = 'true';
  process.env.ALLOWED_ORIGINS = 'https://app.example.com';
  try {
    const browser = new Request('https://api.example.com/api/login', { headers: { Origin: 'https://app.example.com' } });
    const native = new Request('https://api.example.com/api/login');
    const attacker = new Request('https://api.example.com/api/login', { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(auth.isBrowserAuthRequest(browser), true);
    assert.equal(auth.isBrowserAuthRequest(native), false);
    assert.equal(auth.isBrowserAuthRequest(attacker), false);
  } finally {
    if (previousEnabled === undefined) delete process.env.AUTH_BROWSER_SIGN_IN_ENABLED;
    else process.env.AUTH_BROWSER_SIGN_IN_ENABLED = previousEnabled;
    if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousOrigins;
  }
});

test('browser session responses do not expose bearer tokens to page JavaScript', () => {
  const browser = auth.buildAuthSessionResponseBody({
    browserSession: true,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    sessionExpiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'user-a' },
  });
  const native = auth.buildAuthSessionResponseBody({
    browserSession: false,
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    sessionExpiresAt: '2099-01-01T00:00:00.000Z',
    user: { id: 'user-a' },
  });

  assert.deepEqual(browser, { sessionExpiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'user-a' } });
  assert.deepEqual(native, { token: 'access-token', refreshToken: 'refresh-token', sessionExpiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'user-a' } });
});

test('validatePasswordStrength enforces passphrase length and bcrypt byte safety', () => {
  assert.equal(auth.validatePasswordStrength('short-password').isValid, false);
  assert.equal(auth.validatePasswordStrength('a secure phrase!').isValid, true);
  assert.equal(auth.validatePasswordStrength('😀'.repeat(19)).isValid, false);
});

test('sanitizeForLogging redacts secrets embedded in strings and objects', () => {
  const payload = {
    authorization: 'Bearer super-secret-token',
    refreshToken: 'refresh-token-value',
    nested: {
      password: 'hunter2',
      headers: {
        cookie: 'session=abc123',
      },
    },
  };

  const sanitized = sanitizeForLogging(payload);
  assert.deepEqual(sanitized, {
    authorization: '[REDACTED]',
    refreshToken: '[REDACTED]',
    nested: {
      password: '[REDACTED]',
      headers: {
        cookie: '[REDACTED]',
      },
    },
  });
});
