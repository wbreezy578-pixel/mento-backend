import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserFromRequest: vi.fn(),
  getActiveSessionId: vi.fn(),
  findSessionByToken: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllUserSessions: vi.fn(),
}));

vi.mock('../../lib/auth', () => ({
  getUserFromRequest: mocks.getUserFromRequest,
  getActiveSessionId: mocks.getActiveSessionId,
}));
vi.mock('../../../lib/authSession', () => ({
  findSessionByToken: mocks.findSessionByToken,
  revokeSession: mocks.revokeSession,
  revokeAllUserSessions: mocks.revokeAllUserSessions,
}));
vi.mock('../../../lib/securityHeaders', () => ({
  buildCorsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.trymentoapp.com' }),
}));

import { POST } from './logout/route';

function request(body: unknown = {}) {
  return new Request('https://auth.trymentoapp.com/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('logout failure and retry behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserFromRequest.mockResolvedValue({ id: 'user-a' });
    mocks.getActiveSessionId.mockReturnValue('session-a');
    mocks.revokeSession.mockResolvedValue(undefined);
    mocks.revokeAllUserSessions.mockResolvedValue(undefined);
  });

  it('revokes the active session and clears cookies', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.revokeSession).toHaveBeenCalledWith('session-a');
    expect(response.headers.get('set-cookie')).toContain('mento_access_token=');
  });

  it('supports an explicit all-devices logout', async () => {
    const response = await POST(request({ allDevices: true }));
    expect(response.status).toBe(200);
    expect(mocks.revokeAllUserSessions).toHaveBeenCalledWith('user-a');
    expect(mocks.revokeSession).not.toHaveBeenCalled();
  });

  it('returns a safe retryable response when revocation storage fails', async () => {
    mocks.revokeSession.mockRejectedValue(new Error('database password=secret'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Unable to sign out right now.' });
  });

  it('can retry after a transient revocation failure', async () => {
    mocks.revokeSession.mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(undefined);
    expect((await POST(request())).status).toBe(503);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.revokeSession).toHaveBeenCalledTimes(2);
  });
});
