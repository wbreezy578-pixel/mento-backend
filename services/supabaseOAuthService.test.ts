import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_LEGAL_VERSIONS } from '../lib/legalVersions';

const mocks = vi.hoisted(() => ({
  ensureSlidingWindow: vi.fn(),
  createGoogleOAuthAccount: vi.fn(),
}));

vi.mock('../lib/rateLimiter', () => ({ ensureSlidingWindow: mocks.ensureSlidingWindow }));
vi.mock('../lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/env')>();
  return {
    ...actual,
    getSupabaseUrl: () => 'https://supabase.test.invalid',
    getSupabaseClientKey: () => 'test-anon-key',
  };
});
vi.mock('../lib/prisma', () => ({
  prisma: {
    session: { findFirst: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    securityEvent: { create: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));
vi.mock('./userAccountService', () => ({
  createAppleAccount: vi.fn(),
  createGoogleOAuthAccount: mocks.createGoogleOAuthAccount,
}));

import { exchangeSupabaseOAuth } from './supabaseOAuthService';

describe('Supabase OAuth exchange rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSlidingWindow.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a valid Supabase user token that is not bound to the requested provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'provider-user-1',
      email: 'learner@example.com',
      email_confirmed_at: '2026-08-28T12:00:00.000Z',
      app_metadata: { provider: 'github', providers: ['github'] },
      identities: [{ provider: 'github' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const request = new Request('https://auth.trymentoapp.com/api/oauth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': '198.51.100.22' },
      body: JSON.stringify({ access_token: 'provider-access-token', ageConfirmed: true, legalVersions: CURRENT_LEGAL_VERSIONS }),
    });
    const response = await exchangeSupabaseOAuth(request, 'google');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'OAuth identity could not be verified.' });
    expect(mocks.createGoogleOAuthAccount).not.toHaveBeenCalled();
  });
});
