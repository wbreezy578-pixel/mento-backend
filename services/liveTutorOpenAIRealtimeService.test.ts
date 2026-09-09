import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  constructor() { super(); queueMicrotask(() => this.emit('open')); }
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; this.emit('close'); }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

describe('OpenAI Realtime Live Tutor adapter', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_REALTIME_MODEL = 'gpt-realtime-test';
    vi.resetModules();
  });

  it('configures explicit turn control and forwards output audio with generations', async () => {
    const { createOpenAIRealtimeSession, registerOpenAIRealtimeSession, sendOpenAIRealtimePcmAudio, endOpenAIRealtimePcmAudio, interruptOpenAIRealtimeSession, closeOpenAIRealtimeSession } = await import('./liveTutorOpenAIRealtimeService');
    const audio: Uint8Array[] = [];
    const interrupted: number[] = [];
    const session = await createOpenAIRealtimeSession({
      onAudioChunk: async (chunk) => { audio.push(chunk); },
      onInterrupted: (generation) => interrupted.push(generation),
    });
    registerOpenAIRealtimeSession(session);
    const socket = (session as typeof session & { openAiSocket: FakeWebSocket }).openAiSocket;
    const events = () => socket.sent.map((item) => JSON.parse(item) as { type: string; session?: { audio?: { input?: { turn_detection?: unknown }; output?: { speed?: number } } } });
    expect(events()[0]).toMatchObject({ type: 'session.update', session: { audio: { input: { turn_detection: null }, output: { speed: 0.95 } } } });

    sendOpenAIRealtimePcmAudio(session.sessionId, new Uint8Array(640));
    endOpenAIRealtimePcmAudio(session.sessionId);
    expect(events().map((event) => event.type)).toEqual(['session.update', 'input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);

    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.created' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64') })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(audio).toHaveLength(1);
    expect(audio[0]).toEqual(new Uint8Array([1, 2, 3, 4]));

    const replacement = interruptOpenAIRealtimeSession(session.sessionId);
    expect(replacement).toBe(2);
    expect(interrupted).toEqual([1]);
    expect(events().map((event) => event.type).slice(-1)).toEqual(['response.cancel']);
    await closeOpenAIRealtimeSession(session.sessionId);
  });

  it('rejects startup when the OpenAI key is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const { createOpenAIRealtimeSession } = await import('./liveTutorOpenAIRealtimeService');
    await expect(createOpenAIRealtimeSession()).rejects.toThrow('OPENAI_API_KEY is required');
  });
});
