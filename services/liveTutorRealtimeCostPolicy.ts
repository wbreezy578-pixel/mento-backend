type RealtimeTokenUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
};

type RealtimePricing = {
  inputNonAudioPerMillion: number;
  inputAudioPerMillion: number;
  outputTextPerMillion: number;
  outputAudioPerMillion: number;
};

export const LIVE_TUTOR_REALTIME_COST_BASIS = 'conservative-realtime-modality-rates';

function getRealtimePricing(model: string): RealtimePricing | null {
  if (model === 'gpt-realtime-mini' || model === 'gpt-realtime-2.1-mini' || model === 'gpt-realtime-2-mini') {
    return { inputNonAudioPerMillion: 0.8, inputAudioPerMillion: 10, outputTextPerMillion: 2.4, outputAudioPerMillion: 20 };
  }
  if (model === 'gpt-realtime-2' || model === 'gpt-realtime-2.1') {
    return { inputNonAudioPerMillion: 5, inputAudioPerMillion: 32, outputTextPerMillion: 24, outputAudioPerMillion: 64 };
  }
  if (model === 'gpt-realtime' || model === 'gpt-realtime-1.5') {
    return { inputNonAudioPerMillion: 5, inputAudioPerMillion: 32, outputTextPerMillion: 16, outputAudioPerMillion: 64 };
  }
  return null;
}

function safeTokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function estimateLiveTutorRealtimeCostUSD(usage: RealtimeTokenUsage): number | null {
  const pricing = getRealtimePricing(usage.model);
  if (!pricing || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return null;

  const inputTokens = safeTokenCount(usage.inputTokens);
  const outputTokens = safeTokenCount(usage.outputTokens);
  const inputAudioTokens = Math.min(inputTokens, safeTokenCount(usage.inputAudioTokens));
  const outputAudioTokens = Math.min(outputTokens, safeTokenCount(usage.outputAudioTokens));
  const inputNonAudioTokens = inputTokens - inputAudioTokens;
  const outputTextTokens = outputTokens - outputAudioTokens;

  return (
    inputNonAudioTokens * pricing.inputNonAudioPerMillion
    + inputAudioTokens * pricing.inputAudioPerMillion
    + outputTextTokens * pricing.outputTextPerMillion
    + outputAudioTokens * pricing.outputAudioPerMillion
  ) / 1_000_000;
}