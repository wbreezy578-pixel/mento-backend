import { describe, expect, it } from 'vitest';
import { estimateLiveTutorRealtimeCostUSD } from './liveTutorRealtimeCostPolicy';

describe('Live Tutor OpenAI Realtime cost policy', () => {
  it('estimates cost from provider-reported input and output modality tokens', () => {
    expect(estimateLiveTutorRealtimeCostUSD({
      model: 'gpt-realtime',
      inputTokens: 1_000,
      outputTokens: 300,
      inputAudioTokens: 400,
      outputAudioTokens: 100,
    })).toBeCloseTo(0.0254, 7);
  });

  it('returns no estimate when the configured model is not priced', () => {
    expect(estimateLiveTutorRealtimeCostUSD({ model: 'unknown-realtime-model', inputTokens: 100, outputTokens: 100 })).toBeNull();
  });
});