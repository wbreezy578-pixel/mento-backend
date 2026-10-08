import { describe, expect, it } from 'vitest';
import { estimateLiveTutorGeminiCostUSD, getUtcDayWindow, LIVE_TUTOR_IMAGE_DAILY_LIMIT, LIVE_TUTOR_IMAGE_RESERVATION_USD } from './liveTutorImageAnalysisPolicy';

describe('Live Tutor image analysis policy', () => {
  it('uses five requests per UTC day and resets at the next UTC midnight', () => {
    const { start, end, resetAt } = getUtcDayWindow(new Date('2026-09-26T23:59:59.000Z'));

    expect(LIVE_TUTOR_IMAGE_DAILY_LIMIT).toBe(5);
    expect(LIVE_TUTOR_IMAGE_RESERVATION_USD).toBe(0.05);
    expect(start.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    expect(resetAt).toEqual(end);
  });

  it('prices provider-reported Gemini image usage and leaves unknown usage unpriced', () => {
    expect(estimateLiveTutorGeminiCostUSD({
      model: 'gemini-2.5-flash-lite',
      source: 'PROVIDER_REPORTED',
      inputTokens: 10_000,
      outputTokens: 100,
      cachedTokens: 0,
      thinkingTokens: 0,
    })).toBeCloseTo(0.00104, 10);
    expect(estimateLiveTutorGeminiCostUSD({
      model: 'gemini-2.5-flash-lite',
      source: 'UNKNOWN',
      inputTokens: 10_000,
      outputTokens: 100,
    })).toBeNull();
  });
});