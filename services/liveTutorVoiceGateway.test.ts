import { describe, expect, it } from 'vitest';
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
