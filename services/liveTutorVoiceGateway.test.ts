import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isVoiceSessionResumable } from './liveTutorVoiceGateway';

describe('isVoiceSessionResumable', () => {
  it('allows an active session within the reconnect grace period', () => {
    const detachedAt = 1_000;

    expect(isVoiceSessionResumable({ gemini: { status: 'active' }, detachedAt }, detachedAt + 15_000)).toBe(true);
  });

  it('rejects sessions after grace or after provider failure', () => {
    const detachedAt = 1_000;

    expect(isVoiceSessionResumable({ gemini: { status: 'active' }, detachedAt }, detachedAt + 15_001)).toBe(false);
    expect(isVoiceSessionResumable({ gemini: { status: 'error' }, detachedAt }, detachedAt + 1_000)).toBe(false);
  });

  it('rejects a runtime that has not been detached', () => {
    expect(isVoiceSessionResumable({ gemini: { status: 'active' }, detachedAt: null })).toBe(false);
  });
});

describe('voice readiness ordering', () => {
  it('notifies and closes the phone before waiting for provider cleanup', () => {
    const source = readFileSync('services/liveTutorVoiceGateway.ts', 'utf8');
    const start = source.indexOf('onError: (error) => {');
    const end = source.indexOf('onResponseStarted:', start);
    const body = source.slice(start + 'onError: (error) => {'.length, end).replace(/},\s*$/, '');
    const events: string[] = [];
    const activeRef = { current: true };
    const run = new Function('error', 'logger', 'voiceTraceId', 'activeRef', 'socketRef', 'WebSocket', 'identity', 'completeSimliSessionLifecycle', body);
    run(new Error('deadline'), { error() {} }, 'trace', activeRef,
      { current: { readyState: 1, send: (data: string) => events.push(JSON.parse(data).code), close: () => events.push('closed') } },
      { OPEN: 1 }, { streamId: 'stream', userId: 'user' },
      () => { events.push('cleanup'); return new Promise(() => {}); });
    expect(events).toEqual(['provider_session_ended', 'closed', 'cleanup']);
    expect(activeRef.current).toBe(false);
  });
  it('sends auth acknowledgement before provider session setup', () => {
    const source = readFileSync('services/liveTutorVoiceGateway.ts', 'utf8');
    const authSent = source.indexOf("type: 'auth_ok'");
    const providerCreated = source.indexOf('gemini = await createLiveTutorVoiceSession');
    const runtimeRegistered = source.indexOf('voiceSessionRuntimes.set(identity.streamId', providerCreated);
    const usableMarked = source.indexOf('markLiveTutorSessionUsable(identity.streamId, identity.userId)', runtimeRegistered);
    const connectedSent = source.indexOf("socket.send(JSON.stringify({ type: 'connected', sessionId: gemini.sessionId }))", usableMarked);

    expect(authSent).toBeGreaterThanOrEqual(0);
    expect(providerCreated).toBeGreaterThan(authSent);
    expect(runtimeRegistered).toBeGreaterThan(providerCreated);
    expect(usableMarked).toBeGreaterThan(runtimeRegistered);
    expect(connectedSent).toBeGreaterThan(usableMarked);
  });
});
