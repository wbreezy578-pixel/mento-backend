/**
 * Centralized Context Budget Configuration
 *
 * Defines token-based budgets for different subscription tiers and features.
 * Replaces the old character-based 60,000 character limit with a token-aware system.
 *
 * ARCHITECTURE:
 * - System instructions + security prompts: Fixed reserved tokens
 * - Conversation summary: Fixed allocation for older context
 * - Recent conversation turns: Remaining budget after reserved
 * - Latest user input: Checked separately with hard limit
 * - Output tokens: Protected reserve (never consumed by input)
 * - Images: Calculated via provider-reported tokens
 *
 * TOKEN COUNTING METHOD:
 * 1. Try provider token counting (Gemini API) for accuracy
 * 2. Fall back to conservative local estimation if provider unavailable
 * 3. Post-call: Validate against provider-reported usage
 *
 * FUTURE: Free vs Pro plans will use different budgets without code changes
 */

export type SubscriptionTier = 'free' | 'pro';

export interface ContextBudget {
  // Total input tokens available for a single request
  totalInputTokenBudget: number;

  // Reserved tokens for system instructions (never trimmed)
  systemInstructionReservedTokens: number;

  // Tokens allocated for conversation summary (older context)
  conversationSummaryMaxTokens: number;

  // Tokens for recent conversation turns (trimmed by whole turns)
  recentTurnsMaxTokens: number;

  // Absolute maximum tokens for a single latest user input (fails if exceeded)
  latestInputMaxTokens: number;

  // Reserved tokens for model output (protected from input consumption)
  outputTokenReserve: number;

  // Maximum tokens per turn (system + user/model message)
  maxTokensPerTurn: number;

  // Maximum number of recent conversation turns to retain
  maxRecentTurns: number;
}

/**
 * TIER BUDGETS
 *
 * FREE TIER (future):
 * - Lower total budget: 8,000 input tokens
 * - Shorter recent history: 5 turns
 * - Smaller latest input: 3,000 tokens
 *
 * PRO TIER (future):
 * - Higher total budget: 24,000 input tokens
 * - Longer recent history: 15 turns
 * - Larger latest input: 8,000 tokens
 *
 * Current implementation uses PRO-tier defaults to ensure no regressions
 * from the 60,000 character limit (≈ 15,000 tokens average, conservative)
 */

const FREE_TIER_BUDGET: ContextBudget = {
  totalInputTokenBudget: 8_000,
  systemInstructionReservedTokens: 500,
  conversationSummaryMaxTokens: 1_500,
  recentTurnsMaxTokens: 4_000,
  latestInputMaxTokens: 3_000,
  outputTokenReserve: 1_024, // CHAT_MAX_OUTPUT_TOKENS
  maxTokensPerTurn: 5_000,
  maxRecentTurns: 5,
};

const PRO_TIER_BUDGET: ContextBudget = {
  totalInputTokenBudget: 24_000,
  systemInstructionReservedTokens: 800,
  conversationSummaryMaxTokens: 3_000,
  recentTurnsMaxTokens: 16_000,
  latestInputMaxTokens: 8_000,
  outputTokenReserve: 1_024, // CHAT_MAX_OUTPUT_TOKENS
  maxTokensPerTurn: 10_000,
  maxRecentTurns: 15,
};

export function getContextBudgetForTier(tier: SubscriptionTier): ContextBudget {
  switch (tier) {
    case 'free':
      return FREE_TIER_BUDGET;
    case 'pro':
    default:
      return PRO_TIER_BUDGET;
  }
}

/**
 * Get current context budget from environment or default to PRO
 * In future, this will be determined by user's subscription plan
 */
export function getCurrentContextBudget(): ContextBudget {
  const envTier = process.env.CONTEXT_BUDGET_TIER as SubscriptionTier | undefined;
  const tier: SubscriptionTier = envTier && ['free', 'pro'].includes(envTier) ? envTier : 'pro';
  return getContextBudgetForTier(tier);
}

/**
 * Validate that budget configuration is internally consistent
 */
export function validateContextBudget(budget: ContextBudget): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (budget.systemInstructionReservedTokens <= 0) {
    errors.push('systemInstructionReservedTokens must be positive');
  }

  if (budget.outputTokenReserve <= 0) {
    errors.push('outputTokenReserve must be positive');
  }

  const minInputBudget = budget.systemInstructionReservedTokens + budget.outputTokenReserve + 1_000;
  if (budget.totalInputTokenBudget < minInputBudget) {
    errors.push(`totalInputTokenBudget (${budget.totalInputTokenBudget}) must be >= system + output + 1000 (${minInputBudget})`);
  }

  const recentTurnsAvailable = budget.totalInputTokenBudget - budget.systemInstructionReservedTokens - budget.outputTokenReserve;
  if (budget.conversationSummaryMaxTokens + budget.recentTurnsMaxTokens > recentTurnsAvailable) {
    errors.push(`conversationSummaryMaxTokens + recentTurnsMaxTokens must not exceed available budget (${recentTurnsAvailable})`);
  }

  if (budget.latestInputMaxTokens > recentTurnsAvailable) {
    errors.push(`latestInputMaxTokens must not exceed available budget (${recentTurnsAvailable})`);
  }

  if (budget.maxRecentTurns < 1) {
    errors.push('maxRecentTurns must be at least 1');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Token estimation ratios for multilingual text (conservative estimates)
 * Based on Gemini token counting observations
 *
 * English: ~4 characters per token (highly variable)
 * Swahili: ~3.5 characters per token (similar to English)
 * Arabic: ~2 characters per token (diacritics, vowels as marks)
 * Mixed/Unknown: ~3 characters per token (conservative average)
 *
 * IMPORTANT: These are estimates for budget pre-calculation only.
 * Actual token counts from provider (Gemini API) override these estimates.
 */
export const MULTILINGUAL_TOKEN_ESTIMATION = {
  english: { charsPerToken: 4.2, confidence: 'high' },
  swahili: { charsPerToken: 3.8, confidence: 'high' },
  arabic: { charsPerToken: 2.0, confidence: 'medium' }, // Includes diacritics
  mixed: { charsPerToken: 3.0, confidence: 'low' },
  default: { charsPerToken: 3.5, confidence: 'low' },
} as const;

/**
 * Detect if text contains Arabic script
 */
export function hasArabicScript(text: string): boolean {
  // Arabic Unicode ranges: U+0600-U+06FF, U+0750-U+077F, U+08A0-U+08FF
  const arabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g;
  return arabicRegex.test(text);
}

/**
 * Detect if text is primarily English
 */
export function isPrimarilyEnglish(text: string): boolean {
  const englishChars = text.match(/[a-zA-Z0-9\s.,!?;:'"]/g) || [];
  return englishChars.length / Math.max(text.length, 1) > 0.8;
}

/**
 * Estimate language characteristics from text
 */
export function estimateLanguageCharacteristics(text: string): {
  hasArabic: boolean;
  isPrimarilyEnglish: boolean;
  estimatedCharsPerToken: number;
} {
  const hasArabic = hasArabicScript(text);
  const isEnglish = isPrimarilyEnglish(text);

  let estimatedCharsPerToken = Number(MULTILINGUAL_TOKEN_ESTIMATION.default.charsPerToken);
  if (hasArabic) {
    estimatedCharsPerToken = Number(MULTILINGUAL_TOKEN_ESTIMATION.arabic.charsPerToken);
  } else if (isEnglish) {
    estimatedCharsPerToken = Number(MULTILINGUAL_TOKEN_ESTIMATION.english.charsPerToken);
  } else {
    estimatedCharsPerToken = Number(MULTILINGUAL_TOKEN_ESTIMATION.mixed.charsPerToken);
  }

  return {
    hasArabic,
    isPrimarilyEnglish: isEnglish,
    estimatedCharsPerToken,
  };
}
