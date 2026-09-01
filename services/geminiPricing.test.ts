import { describe, expect, it } from 'vitest';
import { calculateGeminiProviderCostUSD, isSupportedNormalChatModel, NORMAL_CHAT_GEMINI_MODELS } from './geminiPricing';

describe('Gemini Normal Chat pricing', () => {
  it('is keyed only by the exact supported model IDs', () => {
    expect(Object.keys(NORMAL_CHAT_GEMINI_MODELS)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]);
    expect(isSupportedNormalChatModel('gemini-2.0-flash')).toBe(false);
  });

  it('prefers the long-term Flash-Lite model over the retiring compatibility model', async () => {
    const { NORMAL_CHAT_COST_AWARE_FALLBACKS } = await import('./geminiPricing');
    expect(NORMAL_CHAT_COST_AWARE_FALLBACKS).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ]);
  });

  it('prices cached input and thinking output using the actual model', () => {
    expect(calculateGeminiProviderCostUSD({
      model: 'gemini-3.1-flash-lite',
      inputTokens: 1_000_000,
      cachedTokens: 200_000,
      outputTokens: 100_000,
      thinkingTokens: 50_000,
    })).toBeCloseTo(0.8 * 0.25 + 0.2 * 0.025 + 0.15 * 1.5, 10);
  });
});
