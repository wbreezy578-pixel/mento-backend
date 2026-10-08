import { describe, expect, it, vi } from 'vitest';
import { createLiveTutorSimliLiveKitAvatarSession, getLiveTutorSimliLiveKitConfig } from './liveTutorSimliLiveKitAvatarSession';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const config = {
  liveKitUrl: 'wss://livekit.example.test',
  liveKitApiKey: 'test-key',
  liveKitApiSecret: 'test-secret-with-enough-entropy',
  roomName: 'phase-three-room',
  agentIdentity: 'mento-gemini-agent',
  subscriberIdentity: 'android-test-client',
  simliApiKey: 'simli-secret',
  faceId: 'face-123',
};

describe('Live Tutor Simli LiveKit avatar session', () => {
  it('attaches Simli with an on-behalf token and returns the session payload', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return requests.length === 1 ? response({ session_token: 'simli-session-token' }) : response({ ok: true });
    }) as unknown as typeof fetch;
    const session = await createLiveTutorSimliLiveKitAvatarSession(config, undefined, {
      fetch: request,
    });

    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.simli.ai/compose/token',
      'https://api.simli.ai/integrations/livekit/agents',
    ]);
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({ faceId: 'face-123', handleSilence: true, maxSessionLength: 600 });
    const attachment = JSON.parse(String(requests[1].init?.body)) as Record<string, string>;
    expect(attachment.session_token).toBe('simli-session-token');
    expect(attachment.livekit_url).toBe(config.liveKitUrl);
    expect(jwtPayload(attachment.livekit_token)).toMatchObject({
      sub: 'simli-avatar-agent',
      kind: 'agent',
      attributes: { 'lk.publish_on_behalf': 'mento-gemini-agent' },
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect((jwtPayload(attachment.livekit_token).exp as number) - nowSeconds).toBeGreaterThanOrEqual(659);
    expect((jwtPayload(attachment.livekit_token).exp as number) - nowSeconds).toBeLessThanOrEqual(661);
    expect(session.avatarIdentity).toBe('simli-avatar-agent');
    expect(session.startupTimings.tokenPreparationMs).toBeGreaterThanOrEqual(0);
    expect(session.startupTimings.simliSessionCreateMs).toBeGreaterThanOrEqual(0);
    expect(session.startupTimings.simliLiveKitAttachMs).toBeGreaterThanOrEqual(0);
    expect(jwtPayload(session.subscriberToken)).toMatchObject({ sub: 'android-test-client' });
    expect((jwtPayload(session.subscriberToken).exp as number) - nowSeconds).toBeGreaterThanOrEqual(659);
    expect((jwtPayload(session.subscriberToken).exp as number) - nowSeconds).toBeLessThanOrEqual(661);

    await session.close();
  });

  it('throws when Simli attachment fails', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ session_token: 'simli-session-token' }))
      .mockResolvedValueOnce(response({ message: 'unavailable' }, 503)) as unknown as typeof fetch;

    await expect(createLiveTutorSimliLiveKitAvatarSession(config, undefined, {
      fetch: request,
    })).rejects.toThrow('Simli LiveKit attachment failed with status 503.');
  });

  it('keeps a safe provider error code but never logs a free-form provider message', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ session_token: 'simli-session-token' }))
      .mockResolvedValueOnce(response({ code: 'INVALID_LIVEKIT_URL', message: 'token=do-not-log' }, 400)) as unknown as typeof fetch;

    await expect(createLiveTutorSimliLiveKitAvatarSession(config, undefined, {
      fetch: request,
    })).rejects.toMatchObject({ status: 400, providerReason: 'invalid_livekit_url' });
  });

  it('requires a public secure LiveKit URL in runtime configuration', () => {
    const previous = process.env.LIVEKIT_URL;
    process.env.LIVEKIT_URL = 'http://127.0.0.1:7880';
    expect(() => getLiveTutorSimliLiveKitConfig({ roomName: 'room', agentIdentity: 'agent', subscriberIdentity: 'subscriber' }))
      .toThrow('LIVEKIT_URL must be a public wss:// URL');
    process.env.LIVEKIT_URL = previous;
  });

  it('retries a throttled attachment using the same Simli session', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ session_token: 'simli-session-token' }))
      .mockResolvedValueOnce(response({ message: 'slow down' }, 429))
      .mockResolvedValueOnce(response({ ok: true })) as unknown as typeof fetch;
    const wait = vi.fn().mockResolvedValue(undefined);

    await createLiveTutorSimliLiveKitAvatarSession(config, undefined, { fetch: request, wait });

    expect(wait).toHaveBeenCalledWith(1_000);
    expect((request as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });
});
