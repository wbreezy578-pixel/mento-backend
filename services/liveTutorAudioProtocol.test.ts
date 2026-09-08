import { describe, expect, it } from 'vitest';
import { normalizePcmForSimli, SIMLI_PCM_FRAME_BYTES, splitPcmIntoSimliFrames, StreamingPcmFrameBuffer } from './liveTutorAudioProtocol';

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
  it('splits provider chunks into 20ms PCM frames without losing the tail', () => {
    const pcm = new Uint8Array(6_000);
    const frames = splitPcmIntoSimliFrames(pcm);

    expect(SIMLI_PCM_FRAME_BYTES).toBe(16000 * 2 * 0.020);
    expect(frames).toHaveLength(10);
    expect(frames[9].byteLength).toBe(240);
    expect(frames[0].byteLength).toBe(SIMLI_PCM_FRAME_BYTES);
  });
});

describe('StreamingPcmFrameBuffer', () => {
  it('preserves partial PCM across chunks and emits only exact 20ms frames', () => {
    const frameBuffer = new StreamingPcmFrameBuffer();
    const first = new Uint8Array(1_000).fill(1);
    const second = new Uint8Array(920).fill(2);

    const firstFrames = frameBuffer.push(first);
    const secondFrames = frameBuffer.push(second);

    expect(firstFrames).toHaveLength(1);
    expect(secondFrames).toHaveLength(2);
    expect([...firstFrames, ...secondFrames].every(frame => frame.byteLength === 640)).toBe(true);
    expect(frameBuffer.remainderBytes).toBe(0);
    expect(secondFrames[0].slice(0, 360)).toEqual(new Uint8Array(360).fill(1));
    expect(secondFrames[0].slice(360)).toEqual(new Uint8Array(280).fill(2));
  });

  it('pads only the final response tail and clears it on interruption', () => {
    const frameBuffer = new StreamingPcmFrameBuffer();
    frameBuffer.push(new Uint8Array(240).fill(7));
    const tail = frameBuffer.flushPadded();
    expect(tail).not.toBeNull();
    expect(tail?.byteLength).toBe(SIMLI_PCM_FRAME_BYTES);
    expect(tail?.slice(0, 240)).toEqual(new Uint8Array(240).fill(7));
    expect(tail?.slice(240)).toEqual(new Uint8Array(400));
    expect(frameBuffer.flushPadded()).toBeNull();

    frameBuffer.push(new Uint8Array(100).fill(9));
    frameBuffer.reset();
    expect(frameBuffer.remainderBytes).toBe(0);
  });
});
