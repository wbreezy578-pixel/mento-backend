import { calculateGeminiProviderCostUSD, isSupportedNormalChatModel } from './geminiPricing';

export const LIVE_TUTOR_IMAGE_DAILY_LIMIT = 5;
export const LIVE_TUTOR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const LIVE_TUTOR_IMAGE_RESERVATION_USD = 0.05;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type LiveTutorGeminiImageUsage = {
  model: string;
  source: 'PROVIDER_REPORTED' | 'ESTIMATED' | 'UNKNOWN';
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  thinkingTokens?: number;
  totalTokens?: number;
};

export function getUtcDayWindow(now = new Date()): { start: Date; end: Date; resetAt: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + ONE_DAY_MS);
  return { start, end, resetAt: end };
}

export function estimateLiveTutorGeminiCostUSD(usage: LiveTutorGeminiImageUsage): number | null {
  if (usage.source === 'UNKNOWN' || !isSupportedNormalChatModel(usage.model)) return null;
  return calculateGeminiProviderCostUSD({
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens ?? 0,
    thinkingTokens: usage.thinkingTokens ?? 0,
  });
}