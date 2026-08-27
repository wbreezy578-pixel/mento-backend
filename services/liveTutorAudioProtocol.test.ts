import { describe, expect, it } from 'vitest';
import { normalizePcmForSimli, SIMLI_PCM_FRAME_BYTES, splitPcmIntoSimliFrames } from './liveTutorAudioProtocol';

describe('normalizePcmForSimli', () => {
  it('resamples Gemini TTS 24 kHz PCM to Simli 16 kHz PCM', () => {
    const sourceSamples = new Int16Array(24000);
    for (let index = 0; index < sourceSamples.length; index += 1) {
      sourceSamples[index] = Math.round(Math.sin(index / 20) * 12000);
    }

    const output = normalizePcmForSimli(
      new Uint8Array(sourceSamples.buffer),
      'audio/pcm;rate=24000',
    );

    expect(output.byteLength).toBe(16000 * 2);
  });

  it('uses Gemini TTS 24 kHz mono defaults when MIME metadata is absent', () => {
    const source = new Uint8Array(2400 * 2);
    const output = normalizePcmForSimli(source);
    expect(output.byteLength).toBe(1600 * 2);
  });

  it('accepts the audio/L16 MIME spelling returned by some Gemini audio responses', () => {
    const source = new Uint8Array(2400 * 2);
    const output = normalizePcmForSimli(source, 'audio/L16;codec=pcm;rate=24000');
    expect(output.byteLength).toBe(1600 * 2);
  });
});

describe('splitPcmIntoSimliFrames', () => {
  it('splits provider bursts into Simli-preferred frames with only a short final frame', () => {
    const pcm = new Uint8Array(SIMLI_PCM_FRAME_BYTES * 3 + 320);
    const frames = splitPcmIntoSimliFrames(pcm);

    expect(frames.map((frame) => frame.byteLength)).toEqual([
      SIMLI_PCM_FRAME_BYTES,
      SIMLI_PCM_FRAME_BYTES,
      SIMLI_PCM_FRAME_BYTES,
      320,
    ]);
  });
});
