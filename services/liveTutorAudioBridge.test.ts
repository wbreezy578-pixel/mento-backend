import { describe, expect, it } from 'vitest';
import { PCMResampler } from './liveTutorAudioBridge';

const pcm = (samples: number[]) => new Uint8Array(new Int16Array(samples).buffer);
const join = (chunks: Uint8Array[]) => Buffer.concat(chunks);
describe('streaming PCM continuity', () => {
  it('matches a single stream for every chunk split, including one-sample chunks', () => {
    const input = pcm(Array.from({ length: 101 }, (_, i) => Math.round(Math.sin(i / 7) * 30000)));
    const whole = new PCMResampler();
    const expected = join([whole.resampleChunk(input), whole.flush()]);
    for (let size = 2; size <= 60; size += 2) {
      const streaming = new PCMResampler();
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < input.length; i += size) {
        chunks.push(streaming.resampleChunk(input.subarray(i, i + size)));
        expect(streaming.getStats().bufferedSamples).toBeLessThanOrEqual(1);
      }
      expect(join([...chunks, streaming.flush()])).toEqual(expected);
    }
    expect(expected.byteLength).toBe(Math.ceil(101 * 2 / 3) * 2);
  });
  it('drops the cancelled interpolation tail and preserves signed PCM extrema', () => {
    const resampler = new PCMResampler();
    resampler.resampleChunk(pcm([30000, 30000]));
    resampler.reset();
    expect(join([resampler.resampleChunk(pcm([-32768, 0, 32767])), resampler.flush()]))
      .toEqual(Buffer.from(pcm([-32768, 16384])));
    expect(resampler.flush()).toHaveLength(0);
  });
  it('rejects malformed samples and emits before turn completion', () => {
    const resampler = new PCMResampler();
    expect(() => resampler.resampleChunk(new Uint8Array(1))).toThrow();
    expect(resampler.resampleChunk(pcm(Array(960).fill(1000)))).toHaveLength(1280);
  });
});
