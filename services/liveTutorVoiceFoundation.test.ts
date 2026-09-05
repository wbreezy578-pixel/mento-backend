import { describe, expect, it } from 'vitest';
import { BoundedPcmQueue, MAX_LIVE_TUTOR_AUDIO_QUEUE_BYTES } from './liveTutorAudioQueue';
import { parsePcmMimeType, resamplePcm16Mono, validateLiveTutorPcm16 } from './liveTutorAudioProtocol';

describe('Live Tutor voice foundation', () => {
  it('rejects empty and non-sample-aligned PCM', () => {
    expect(() => validateLiveTutorPcm16(new Uint8Array())).toThrow();
    expect(() => validateLiveTutorPcm16(new Uint8Array([1]))).toThrow();
    expect(() => validateLiveTutorPcm16(new Uint8Array([1, 2]))).not.toThrow();
  });

  it('parses and verifies PCM MIME metadata', () => {
    expect(parsePcmMimeType('audio/pcm;rate=24000')).toEqual({ encoding: 'signed 16-bit little-endian PCM', sampleRate: 24000, channels: 1 });
    expect(() => parsePcmMimeType('audio/wav')).toThrow();
  });

  it('resamples 24 kHz mono PCM to 16 kHz with 3:2 interpolation', () => {
    const input = new Int16Array([0, 1000, 2000, 3000]);
    const output = new Int16Array(resamplePcm16Mono(new Uint8Array(input.buffer), 24000, 16000).buffer);
    expect(Array.from(output)).toEqual([0, 1500, 3000]);
  });

  it('bounds response audio and clears stale generations', () => {
    const queue = new BoundedPcmQueue();
    queue.enqueue(new Uint8Array(MAX_LIVE_TUTOR_AUDIO_QUEUE_BYTES), 'audio/pcm;rate=24000', 1);
    queue.enqueue(new Uint8Array(2), 'audio/pcm;rate=24000', 2);
    expect(queue.metrics().bytesBuffered).toBe(2);
    queue.clear();
    expect(queue.metrics()).toEqual({ queueDepth: 0, bytesBuffered: 0, chunksBuffered: 0 });
    queue.enqueue(new Uint8Array([1, 2]), 'audio/pcm;rate=24000', 3);
    expect(queue.take(2)).toBeUndefined();
    expect(queue.metrics().bytesBuffered).toBe(0);
  });
});