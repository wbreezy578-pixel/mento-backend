import { describe, expect, it } from 'vitest';
import { buildLiveTutorRealtimeVoiceUsageRecord } from './liveTutorRealtimeVoiceUsage';

const usage = {
  responseId: 'resp_123',
  model: 'gpt-realtime',
  inputTokens: 1_000,
  outputTokens: 300,
  totalTokens: 1_300,
  inputAudioTokens: 400,
  inputTextTokens: 600,
  inputImageTokens: 0,
  cachedInputTokens: 100,
  outputAudioTokens: 100,
  outputTextTokens: 200,
  cancelled: false,
  timestampMs: 1_700_000_000_000,
  durationMs: 1_200,
  ttftMs: 240,
};

describe('Live Tutor OpenAI Realtime usage records', () => {
  it('records provider-reported voice tokens in a separate, idempotently keyed ledger row', () => {
    const record = buildLiveTutorRealtimeVoiceUsageRecord({ userId: 'user-1', streamId: 'stream-1', usage });

    expect(record).toMatchObject({
      feature: 'live_tutor_voice',
      provider: 'OpenAI Realtime',
      tokensInput: 1_000,
      tokensOutput: 300,
      tokensCached: 100,
      tokensTotal: 1_300,
      usageSource: 'PROVIDER_REPORTED',
      modelUsed: 'gpt-realtime',
      providerCostUSD: 0.0254,
    });
    expect(record.requestId).toMatch(/^ltv-[a-f0-9]{64}$/);
    expect(record.requestId).toBe(buildLiveTutorRealtimeVoiceUsageRecord({ userId: 'user-1', streamId: 'stream-1', usage }).requestId);
    expect(record.metadata).toMatchObject({
      streamId: 'stream-1',
      responseId: 'resp_123',
      inputAudioTokens: 400,
      outputAudioTokens: 100,
      costEstimateUnavailable: false,
    });
  });

  it('preserves token usage and marks cost unavailable for unpriced models', () => {
    const record = buildLiveTutorRealtimeVoiceUsageRecord({
      userId: 'user-1',
      streamId: 'stream-1',
      usage: { ...usage, model: 'future-realtime-model' },
    });

    expect(record.tokensTotal).toBe(1_300);
    expect(record.providerCostUSD).toBe(0);
    expect(record.metadata).toMatchObject({ costEstimateUnavailable: true });
  });
});