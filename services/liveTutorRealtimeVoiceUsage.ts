import { createHash } from 'node:crypto';
import { estimateLiveTutorRealtimeCostUSD, LIVE_TUTOR_REALTIME_COST_BASIS } from './liveTutorRealtimeCostPolicy';

export type LiveTutorRealtimeVoiceUsageSnapshot = {
  responseId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputAudioTokens: number;
  inputTextTokens: number;
  inputImageTokens: number;
  cachedInputTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
  cancelled: boolean;
  timestampMs: number;
  durationMs: number;
  ttftMs: number;
};

export function buildLiveTutorRealtimeVoiceUsageRecord(input: {
  userId: string;
  streamId: string;
  usage: LiveTutorRealtimeVoiceUsageSnapshot;
}) {
  const requestId = `ltv-${createHash('sha256').update(input.streamId).update('\0').update(input.usage.responseId).digest('hex')}`;
  const providerCostUSD = estimateLiveTutorRealtimeCostUSD({
    model: input.usage.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    inputAudioTokens: input.usage.inputAudioTokens,
    outputAudioTokens: input.usage.outputAudioTokens,
  });

  return {
    userId: input.userId,
    feature: 'live_tutor_voice',
    provider: 'OpenAI Realtime',
    requestId,
    tokensInput: input.usage.inputTokens,
    tokensOutput: input.usage.outputTokens,
    tokensCached: input.usage.cachedInputTokens,
    tokensTotal: input.usage.totalTokens,
    usageSource: 'PROVIDER_REPORTED',
    secondsUsed: 0,
    providerCostUSD: providerCostUSD ?? 0,
    providerExposureUSD: 0,
    userChargeUSD: 0,
    profitUSD: providerCostUSD === null ? 0 : -providerCostUSD,
    modelUsed: input.usage.model,
    success: true,
    metadata: {
      streamId: input.streamId,
      responseId: input.usage.responseId,
      cancelled: input.usage.cancelled,
      timestampMs: input.usage.timestampMs,
      durationMs: input.usage.durationMs,
      ttftMs: input.usage.ttftMs,
      inputAudioTokens: input.usage.inputAudioTokens,
      inputTextTokens: input.usage.inputTextTokens,
      inputImageTokens: input.usage.inputImageTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      outputAudioTokens: input.usage.outputAudioTokens,
      outputTextTokens: input.usage.outputTextTokens,
      costEstimateUnavailable: providerCostUSD === null,
      costBasis: LIVE_TUTOR_REALTIME_COST_BASIS,
    },
  };
}