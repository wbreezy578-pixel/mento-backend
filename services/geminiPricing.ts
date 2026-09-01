export const NORMAL_CHAT_GEMINI_MODELS = {
  'gemini-3.5-flash': {
    tier: 'flash',
    inputPerMillionUSD: 1.5,
    outputPerMillionUSD: 9,
    cachedInputPerMillionUSD: 0.15,
  },
  'gemini-3.5-flash-lite': {
    tier: 'flash-lite',
    inputPerMillionUSD: 0.3,
    outputPerMillionUSD: 2.5,
    cachedInputPerMillionUSD: 0.03,
  },
  // Transitional compatibility only. Google schedules shutdown for
  // 2027-05-07 and recommends gemini-3.5-flash-lite as its replacement.
  'gemini-3.1-flash-lite': {
    tier: 'flash-lite',
    inputPerMillionUSD: 0.25,
    outputPerMillionUSD: 1.5,
    cachedInputPerMillionUSD: 0.025,
  },
  'gemini-2.5-flash': {
    tier: 'flash',
    inputPerMillionUSD: 0.3,
    outputPerMillionUSD: 2.5,
    cachedInputPerMillionUSD: 0.03,
  },
  'gemini-2.5-flash-lite': {
    tier: 'flash-lite',
    inputPerMillionUSD: 0.1,
    outputPerMillionUSD: 0.4,
    cachedInputPerMillionUSD: 0.01,
  },
} as const;

// Verified against the Gemini Developer API standard paid-tier pricing page
// on 2026-08-31. Updating model IDs or prices requires updating the focused
// tests in the same change.
export const GEMINI_PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
export const GEMINI_PRICING_VERSION = '2026-08-31';

export type NormalChatGeminiModel = keyof typeof NORMAL_CHAT_GEMINI_MODELS;

export const NORMAL_CHAT_COST_AWARE_FALLBACKS: readonly NormalChatGeminiModel[] = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];

export function isSupportedNormalChatModel(model: string): model is NormalChatGeminiModel {
  return Object.prototype.hasOwnProperty.call(NORMAL_CHAT_GEMINI_MODELS, model);
}

export function calculateGeminiProviderCostUSD(input: {
  model: NormalChatGeminiModel;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
}): number {
  const price = NORMAL_CHAT_GEMINI_MODELS[input.model];
  const cachedTokens = Math.min(Math.max(0, input.cachedTokens), Math.max(0, input.inputTokens));
  const uncachedInputTokens = Math.max(0, input.inputTokens - cachedTokens);
  const billableOutputTokens = Math.max(0, input.outputTokens) + Math.max(0, input.thinkingTokens);
  return (
    uncachedInputTokens * price.inputPerMillionUSD
    + cachedTokens * price.cachedInputPerMillionUSD
    + billableOutputTokens * price.outputPerMillionUSD
  ) / 1_000_000;
}
