import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('../../lib/env', () => ({
  loadAndValidateEnvironment: vi.fn(),
  getJwtSecret: vi.fn(() => 'test-jwt-secret-with-sufficient-entropy'),
}));
vi.mock('../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  applyAuthCookies,
  buildAuthSessionResponseBody,
  getAuthTokenFromRequest,
  getRefreshTokenFromBrowserCookie,
  isBrowserAuthRequest,
} from './auth';

describe('browser authentication response policy', () => {
  const originalEnabled = process.env.AUTH_BROWSER_SIGN_IN_ENABLED;
  const originalOrigins = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.AUTH_BROWSER_SIGN_IN_ENABLED;
    else process.env.AUTH_BROWSER_SIGN_IN_ENABLED = originalEnabled;
    if (originalOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = originalOrigins;
  });

  it('uses cookies and a token-free response only for an enabled allowlisted browser origin', () => {
    process.env.AUTH_BROWSER_SIGN_IN_ENABLED = 'true';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const browserRequest = new Request('https://api.example.com/api/login', { headers: { Origin: 'https://app.example.com' } });
    const nativeRequest = new Request('https://api.example.com/api/login');

    expect(isBrowserAuthRequest(browserRequest)).toBe(true);
    expect(isBrowserAuthRequest(nativeRequest)).toBe(false);
    expect(getRefreshTokenFromBrowserCookie(new Request('https://api.example.com/api/auth/refresh', {
      headers: { Origin: 'https://evil.example.com', Cookie: 'mento_refresh_token=refresh-token' },
    }))).toBeNull();
    expect(getAuthTokenFromRequest(new Request('https://api.example.com/api/chat', {
      headers: { Origin: 'https://evil.example.com', Cookie: 'mento_access_token=access-token' },
    }))).toEqual({ token: null, source: 'none' });
    expect(getAuthTokenFromRequest(new Request('https://api.example.com/api/chat', {
      headers: { Origin: 'https://app.example.com', Cookie: 'mento_access_token=access-token' },
    }))).toEqual({ token: 'access-token', source: 'cookie' });
    expect(buildAuthSessionResponseBody({
      browserSession: true,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      sessionExpiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'user-a' },
    })).toEqual({ sessionExpiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'user-a' } });

    const response = NextResponse.json({ ok: true });
    applyAuthCookies(response, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      isProduction: true,
      browserSession: true,
    });
    expect(response.cookies.get('mento_access_token')?.value).toBe('access-token');
    expect(response.cookies.get('mento_refresh_token')?.value).toBe('refresh-token');
  });

  it('keeps native token delivery and does not create browser cookies for a native request', () => {
    process.env.AUTH_BROWSER_SIGN_IN_ENABLED = 'true';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    expect(buildAuthSessionResponseBody({
      browserSession: false,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      sessionExpiresAt: '2099-01-01T00:00:00.000Z',
      user: { id: 'user-a' },
    })).toMatchObject({ token: 'access-token', refreshToken: 'refresh-token' });

    const response = NextResponse.json({ ok: true });
    applyAuthCookies(response, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      isProduction: true,
      browserSession: false,
    });
    expect(response.cookies.get('mento_access_token')).toBeUndefined();
    expect(response.cookies.get('mento_refresh_token')).toBeUndefined();
  });
});
