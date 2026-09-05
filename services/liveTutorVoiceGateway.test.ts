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
  it('marks usability only after Gemini/runtime registration and before connected', () => {
    const source = readFileSync('services/liveTutorVoiceGateway.ts', 'utf8');
    const geminiCreated = source.indexOf('gemini = await createGeminiLiveSession');
    const runtimeRegistered = source.indexOf('voiceSessionRuntimes.set(identity.streamId', geminiCreated);
    const usableMarked = source.indexOf('markLiveTutorSessionUsable(identity.streamId, identity.userId)', runtimeRegistered);
    const connectedSent = source.indexOf("socket.send(JSON.stringify({ type: 'connected', sessionId: gemini.sessionId }))", usableMarked);

    expect(geminiCreated).toBeGreaterThanOrEqual(0);
    expect(runtimeRegistered).toBeGreaterThan(geminiCreated);
    expect(usableMarked).toBeGreaterThan(runtimeRegistered);
    expect(connectedSent).toBeGreaterThan(usableMarked);
  });
});
