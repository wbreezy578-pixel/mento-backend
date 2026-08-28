import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ensureCooldown: vi.fn() }));
vi.mock('./rateLimiter', () => ({ ensureCooldown: mocks.ensureCooldown }));

import { buildInternalJobSignature, verifyInternalJobRequest } from './internalJobAuth';

const secret = 'test-secret-with-sufficient-entropy';
const now = new Date('2026-08-28T12:00:00.000Z');

function signedRequest(pathname = '/api/internal/retention', overrides: Record<string, string> = {}) {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const nonce = 'nonce_1234567890abcdef';
  const signature = buildInternalJobSignature(secret, { timestamp, nonce, method: 'POST', pathname });
  return new Request(`https://auth.trymentoapp.com${pathname}`, {
    method: 'POST',
    headers: {
      'x-mento-timestamp': timestamp,
      'x-mento-nonce': nonce,
      'x-mento-signature': signature,
      ...overrides,
    },
  });
}

function signedMillisecondRequest(pathname = '/api/internal/retention') {
  const timestamp = String(now.getTime());
  const nonce = 'nonce_ms_1234567890';
  const signature = buildInternalJobSignature(secret, { timestamp, nonce, method: 'POST', pathname });
  return new Request(`https://auth.trymentoapp.com${pathname}`, {
    method: 'POST',
    headers: {
      'x-mento-timestamp': timestamp,
      'x-mento-nonce': nonce,
      'x-mento-signature': signature,
    },
  });
}

describe('internal maintenance request authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureCooldown.mockResolvedValue({ ok: true });
  });

  it('accepts a fresh path-bound signature and claims its nonce', async () => {
    await expect(verifyInternalJobRequest(signedRequest(), secret, now)).resolves.toEqual({ ok: true });
    expect(mocks.ensureCooldown).toHaveBeenCalledOnce();
  });

  it('rejects signatures replayed against another maintenance path', async () => {
    const request = signedRequest('/api/internal/retention');
    const replay = new Request('https://auth.trymentoapp.com/api/internal/account-deletions', {
      method: 'POST',
      headers: request.headers,
    });
    await expect(verifyInternalJobRequest(replay, secret, now)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects stale requests and repeated nonces', async () => {
    const staleNow = new Date(now.getTime() + 301_000);
    await expect(verifyInternalJobRequest(signedRequest(), secret, staleNow)).resolves.toEqual({ ok: false, reason: 'expired' });

    mocks.ensureCooldown.mockResolvedValueOnce({ ok: false });
    await expect(verifyInternalJobRequest(signedRequest(), secret, now)).resolves.toEqual({ ok: false, reason: 'replayed' });
  });

  it('accepts millisecond timestamps from job runners', async () => {
    await expect(verifyInternalJobRequest(signedMillisecondRequest(), secret, now)).resolves.toEqual({ ok: true });
  });
});
