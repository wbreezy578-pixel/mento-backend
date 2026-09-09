import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Room } from '@livekit/rtc-node';
import { createLiveTutorSimliLiveKitAvatarSession } from './liveTutorSimliLiveKitAvatarSession';

class FakeRoom extends EventEmitter {
  remoteParticipants = new Map();
  isConnected = false;
  connect = vi.fn(async () => { this.isConnected = true; });
  disconnect = vi.fn(async () => { this.isConnected = false; });
}

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
  it('attaches Simli with an on-behalf token and targets its private audio stream', async () => {
    const room = new FakeRoom();
    room.remoteParticipants.set('simli-avatar-agent', { identity: 'simli-avatar-agent' });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return requests.length === 1 ? response({ session_token: 'simli-session-token' }) : response({ ok: true });
    }) as unknown as typeof fetch;
    const output = {
      captureFrame: vi.fn(async () => undefined),
      clearBuffer: vi.fn(),
      flush: vi.fn(),
      waitForPlayout: vi.fn(async () => ({ playbackPosition: 0, interrupted: false })),
    };
    const createAudioOutput = vi.fn(() => output);

    const session = await createLiveTutorSimliLiveKitAvatarSession(config, undefined, {
      fetch: request,
      createRoom: () => room as unknown as Room,
      createAudioOutput,
    });

    expect(room.connect).toHaveBeenCalledOnce();
    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.simli.ai/compose/token',
      'https://api.simli.ai/integrations/livekit/agents',
    ]);
    expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({ faceId: 'face-123', handleSilence: true });
    const attachment = JSON.parse(String(requests[1].init?.body)) as Record<string, string>;
    expect(attachment.session_token).toBe('simli-session-token');
    expect(attachment.livekit_url).toBe(config.liveKitUrl);
    expect(jwtPayload(attachment.livekit_token)).toMatchObject({
      sub: 'simli-avatar-agent',
      kind: 'agent',
      attributes: { 'lk.publish_on_behalf': 'mento-gemini-agent' },
    });
    expect(createAudioOutput).toHaveBeenCalledWith(room, 'simli-avatar-agent');
    expect(session.avatarIdentity).toBe('simli-avatar-agent');
    expect(jwtPayload(session.subscriberToken)).toMatchObject({ sub: 'android-test-client' });

    await session.close();
    expect(output.clearBuffer).toHaveBeenCalledOnce();
    expect(output.flush).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects the room and does not create audio output when Simli attachment fails', async () => {
    const room = new FakeRoom();
    const request = vi.fn()
      .mockResolvedValueOnce(response({ session_token: 'simli-session-token' }))
      .mockResolvedValueOnce(response({ message: 'unavailable' }, 503)) as unknown as typeof fetch;
    const createAudioOutput = vi.fn();

    await expect(createLiveTutorSimliLiveKitAvatarSession(config, undefined, {
      fetch: request,
      createRoom: () => room as unknown as Room,
      createAudioOutput,
    })).rejects.toThrow('Simli LiveKit attachment failed with status 503.');

    expect(createAudioOutput).not.toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalledOnce();
  });
});
