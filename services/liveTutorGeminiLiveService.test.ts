import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = await import('../lib/logger');
const sendRealtimeInput = vi.fn();
let geminiCallbacks: any;

vi.mock('../lib/env', () => ({
  getGeminiApiKey: () => 'test-key',
  loadAndValidateEnvironment: () => undefined,
}));

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@google/genai', () => ({
  StartSensitivity: { START_SENSITIVITY_HIGH: 'START_SENSITIVITY_HIGH' },
  EndSensitivity: { END_SENSITIVITY_HIGH: 'END_SENSITIVITY_HIGH' },
  GoogleGenAI: class {
    live = {
      connect: vi.fn(async (options: any) => {
        geminiCallbacks = options.callbacks;
        return {
        sendRealtimeInput,
        close: vi.fn(),
        };
      }),
    };
  },
  Modality: { AUDIO: 'AUDIO' },
}));

it('includes the phase-4 response-mode rules in the live tutor system prompt', async () => {
  const { buildLiveTutorSystemInstruction, classifyLiveTutorResponseMode } = await import('./liveTutorGeminiLiveService');

  const prompt = buildLiveTutorSystemInstruction();

  expect(prompt).toContain('Fast direct response');
  expect(prompt).toContain('Short acknowledgment');
  expect(prompt).toContain('Thinking/processing bridge');
  expect(prompt).toContain('newest completed user turn is always the active conversational focus');
  expect(classifyLiveTutorResponseMode('What is gravity?')).toBe('fast_direct');
  expect(classifyLiveTutorResponseMode('Wait, explain that again')).toBe('short_acknowledgment');
  expect(classifyLiveTutorResponseMode('Solve this equation carefully and step by step')).toBe('thinking_bridge');
});

describe('Gemini Live PCM lifecycle', () => {
  beforeEach(() => {
    sendRealtimeInput.mockClear();
    vi.mocked(logger.default.info).mockClear();
    vi.mocked(logger.default.warn).mockClear();
    vi.mocked(logger.default.error).mockClear();
    geminiCallbacks = undefined;
  });

  it('forwards successful provider audio chunks to the callback without blocking the session', async () => {
    const onAudioChunk = vi.fn(
  async (
    _chunk: Uint8Array,
    _mimeType: string,
    _timestamp: number,
    generationId: number
  ) => {
    void generationId;
    return undefined;
  }
);
    const { closeGeminiLiveSession, createGeminiLiveSession } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-success', onAudioChunk });
    const audioMessage = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=', mimeType: 'audio/pcm;rate=24000' } }] } } };

    expect(() => geminiCallbacks.onmessage(audioMessage)).not.toThrow();
    await Promise.resolve();

    expect(onAudioChunk).toHaveBeenCalledTimes(1);
    expect(onAudioChunk).toHaveBeenCalledWith(expect.any(Uint8Array), 'audio/pcm;rate=24000', expect.any(Number), session.generationId);
    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('serializes provider audio callbacks in arrival order', async () => {
    let releaseFirstCallback!: () => void;
    const firstCallbackReleased = new Promise<void>((resolve) => {
      releaseFirstCallback = resolve;
    });
    const receivedChunks: number[] = [];
    const onAudioChunk = vi.fn(
  async (
    chunk: Uint8Array,
    mimeType?: string,
    timestamp?: number,
    generationId?: number
  ) => {
      receivedChunks.push(chunk[0]);
      if (receivedChunks.length === 1) await firstCallbackReleased;
    });
    const { closeGeminiLiveSession, createGeminiLiveSession } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-ordered', onAudioChunk });

    geminiCallbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQ==', mimeType: 'audio/pcm;rate=24000' } }] } } });
    geminiCallbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'Ag==', mimeType: 'audio/pcm;rate=24000' } }] } } });
    await Promise.resolve();

    expect(receivedChunks).toEqual([1]);
    releaseFirstCallback();
    await session.audioCallbackQueue;
    expect(receivedChunks).toEqual([1, 2]);
    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('accepts a second PCM turn on the same active connection', async () => {
    const { closeGeminiLiveSession, createGeminiLiveSession, endRealtimePcmAudio, sendRealtimePcmAudio } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-1' });
    const pcm = new Uint8Array([1, 2]);

    sendRealtimePcmAudio(session.sessionId, pcm);
    endRealtimePcmAudio(session.sessionId);
    geminiCallbacks.onmessage({ serverContent: { turnComplete: true } });
    sendRealtimePcmAudio(session.sessionId, pcm);
    endRealtimePcmAudio(session.sessionId);

    expect(sendRealtimeInput).toHaveBeenCalledTimes(2);
    expect(sendRealtimeInput).toHaveBeenNthCalledWith(1, expect.objectContaining({ audio: expect.any(Object) }));
    expect(sendRealtimeInput).toHaveBeenNthCalledWith(2, expect.objectContaining({ audio: expect.any(Object) }));
    expect(session.status).toBe('active');

    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('releases the interrupted turn so a later turn is accepted', async () => {
    const { closeGeminiLiveSession, createGeminiLiveSession, sendRealtimePcmAudio } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-interrupt' });
    const pcm = new Uint8Array([1, 2]);

    sendRealtimePcmAudio(session.sessionId, pcm);
    geminiCallbacks.onmessage({ serverContent: { interrupted: true } });
    sendRealtimePcmAudio(session.sessionId, pcm);

    expect(session.turnNumber).toBe(2);
    expect(session.inputActivityEnded).toBe(false);
    expect(session.status).toBe('active');
    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('accepts a later turn when provider turnComplete is delayed or missing', async () => {
    const { closeGeminiLiveSession, createGeminiLiveSession, endRealtimePcmAudio, sendRealtimePcmAudio } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-delayed-complete' });
    const pcm = new Uint8Array([1, 2]);

    sendRealtimePcmAudio(session.sessionId, pcm);
    endRealtimePcmAudio(session.sessionId);
    endRealtimePcmAudio(session.sessionId);
    sendRealtimePcmAudio(session.sessionId, pcm);
    geminiCallbacks.onmessage({ serverContent: { turnComplete: true } });

    expect(session.turnNumber).toBe(2);
    expect(session.inputActivityEnded).toBe(true);
    expect(sendRealtimeInput).toHaveBeenCalledTimes(2);
    expect(sendRealtimeInput).toHaveBeenNthCalledWith(2, expect.objectContaining({ audio: expect.any(Object) }));
    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('ignores provider audio that arrives after generation cancellation', async () => {
    const onAudioChunk = vi.fn(async () => undefined);
    const { closeGeminiLiveSession, createGeminiLiveSession, interruptGeminiLiveSession, sendRealtimePcmAudio } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-generation', onAudioChunk });
    const pcm = new Uint8Array([1, 2]);
    const audioMessage = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=', mimeType: 'audio/pcm;rate=24000' } }] } } };

    sendRealtimePcmAudio(session.sessionId, pcm);
    geminiCallbacks.onmessage(audioMessage);
    await session.audioCallbackQueue;
    interruptGeminiLiveSession(session.sessionId);
    geminiCallbacks.onmessage(audioMessage);
    await session.audioCallbackQueue;
    expect(onAudioChunk).toHaveBeenCalledTimes(1);

    sendRealtimePcmAudio(session.sessionId, pcm);
    geminiCallbacks.onmessage(audioMessage);
    await Promise.resolve();
    expect(onAudioChunk).toHaveBeenCalledTimes(2);
    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('keeps one Gemini session usable for ten turns across an interruption', async () => {
    const onAudioChunk = vi.fn(async () => undefined);
    const { closeGeminiLiveSession, createGeminiLiveSession, interruptGeminiLiveSession, sendRealtimePcmAudio, endRealtimePcmAudio } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-ten-turns', onAudioChunk });
    const pcm = new Uint8Array([1, 2]);
    const audioMessage = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=', mimeType: 'audio/pcm;rate=24000' } }] } } };

    for (let turn = 1; turn <= 10; turn += 1) {
      sendRealtimePcmAudio(session.sessionId, pcm);
      endRealtimePcmAudio(session.sessionId);
      geminiCallbacks.onmessage(audioMessage);
      if (turn === 5) {
        interruptGeminiLiveSession(session.sessionId);
        geminiCallbacks.onmessage(audioMessage);
      } else {
        geminiCallbacks.onmessage({ serverContent: { turnComplete: true } });
      }
    }
    await session.audioCallbackQueue;

    expect(session.turnNumber).toBe(10);
    expect(session.status).toBe('active');
    expect(sendRealtimeInput).toHaveBeenCalledTimes(10);
    expect(onAudioChunk).toHaveBeenCalledTimes(10);
    expect((onAudioChunk.mock.calls as unknown[][]).map((call) => call[3])).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);

    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('logs rejected audio callbacks and keeps the Gemini session alive', async () => {
    const rejectedCallback = vi.fn(async () => {
      throw new Error('callback failed');
    });
    const { closeGeminiLiveSession, createGeminiLiveSession } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-callback-fail', onAudioChunk: rejectedCallback });
    const audioMessage = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQI=', mimeType: 'audio/pcm;rate=24000' } }] } } };

    expect(() => geminiCallbacks.onmessage(audioMessage)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(rejectedCallback).toHaveBeenCalledTimes(1);
    expect(logger.default.error).toHaveBeenCalledWith(
      '[LiveTutorVoiceServer] gemini_audio_callback_failed',
      expect.objectContaining({
        sessionId: session.sessionId,
        streamId: 'stream-callback-fail',
        generationId: expect.any(Number),
        mimeType: 'audio/pcm;rate=24000',
        byteLength: expect.any(Number),
        category: 'live_tutor_voice_gemini_audio',
      })
    );

    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });

  it('does not report a provider error when a close is part of a graceful shutdown', async () => {
    const onError = vi.fn();
    const { closeGeminiLiveSession, createGeminiLiveSession } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-close-race', onError });
    session.client!.close = vi.fn(() => geminiCallbacks.onclose());

    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');

    expect(onError).not.toHaveBeenCalled();
    expect(session.status).toBe('closed');
  });

  it('transitions the session to error without leaving it falsely active', async () => {
    const { closeGeminiLiveSession, createGeminiLiveSession } = await import('./liveTutorGeminiLiveService');
    const session = await createGeminiLiveSession({ streamId: 'stream-error' });

    geminiCallbacks.onerror({ message: 'provider failure' });

    expect(session.status).toBe('error');
    await closeGeminiLiveSession(session.sessionId, 'test_cleanup');
  });
});