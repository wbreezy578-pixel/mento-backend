import type { NormalChatGeminiModel } from './geminiPricing';

export type CanonicalPlanName = 'FREE' | 'PRO';

export interface ProductPolicy {
  name: CanonicalPlanName;
  priceMonthlyUSD: number;
  normalChat: {
    model: NormalChatGeminiModel;
    allowedModels: readonly NormalChatGeminiModel[];
    dailyCompletedMessages: number;
    monthlyCompletedMessages: number;
    imageQuestionsPerDay: number;
    maxConcurrentGenerations: number;
  };
  liveTutor: {
    enabled: boolean;
    includedSecondsPerPeriod: number;
    maxConcurrentSessions: number;
    maxSessionSeconds: number;
  };
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function getProductPolicy(plan: string | null | undefined): ProductPolicy {
  if (plan === 'PRO') {
    return {
      name: 'PRO',
      priceMonthlyUSD: 29,
      normalChat: {
        model: 'gemini-3.5-flash',
        allowedModels: ['gemini-3.5-flash', 'gemini-3.5-flash-lite'],
        // Conservative fair-use defaults, not a marketing promise. Production
        // may tune them centrally through server environment configuration.
        dailyCompletedMessages: configuredPositiveInteger('PRO_CHAT_DAILY_LIMIT', 120),
        monthlyCompletedMessages: configuredPositiveInteger('PRO_CHAT_MONTHLY_LIMIT', 3000),
        imageQuestionsPerDay: configuredPositiveInteger('PRO_IMAGE_DAILY_LIMIT', 30),
        maxConcurrentGenerations: 1,
      },
      liveTutor: {
        enabled: true,
        includedSecondsPerPeriod: 120 * 60,
        maxConcurrentSessions: 1,
        maxSessionSeconds: configuredPositiveInteger('PRO_LIVE_TUTOR_MAX_SESSION_SECONDS', 30 * 60),
      },
    };
  }

  return {
    name: 'FREE',
    priceMonthlyUSD: 0,
    normalChat: {
      model: 'gemini-3.5-flash-lite',
      allowedModels: ['gemini-3.5-flash-lite'],
      dailyCompletedMessages: configuredPositiveInteger('FREE_CHAT_DAILY_LIMIT', 30),
      monthlyCompletedMessages: configuredPositiveInteger('FREE_CHAT_MONTHLY_LIMIT', 500),
      imageQuestionsPerDay: configuredPositiveInteger('FREE_IMAGE_DAILY_LIMIT', 3),
      maxConcurrentGenerations: 1,
    },
    liveTutor: {
      enabled: false,
      includedSecondsPerPeriod: 0,
      maxConcurrentSessions: 0,
      maxSessionSeconds: 0,
    },
  };
}

export function getUtcDayWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export function getFreeMonthlyWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

export function resolvePolicyModel(plan: string | null | undefined, requested?: string | null): NormalChatGeminiModel {
  const policy = getProductPolicy(plan);
  return requested && policy.normalChat.allowedModels.includes(requested as NormalChatGeminiModel)
    ? requested as NormalChatGeminiModel
    : policy.normalChat.model;
}

export function evaluateCompletedAllowance(input: {
  dailyUsed: number;
  monthlyUsed: number;
  dailyLimit: number;
  monthlyLimit: number;
  requested?: number;
}) {
  const requested = input.requested ?? 1;
  if (![input.dailyUsed, input.monthlyUsed, input.dailyLimit, input.monthlyLimit, requested].every(Number.isSafeInteger)
    || input.dailyUsed < 0 || input.monthlyUsed < 0 || input.dailyLimit <= 0 || input.monthlyLimit <= 0 || requested <= 0) {
    throw new Error('Allowance counters are invalid.');
  }
  const allowed = input.dailyUsed + requested <= input.dailyLimit && input.monthlyUsed + requested <= input.monthlyLimit;
  return {
    allowed,
    dailyRemaining: Math.max(input.dailyLimit - input.dailyUsed - requested, 0),
    monthlyRemaining: Math.max(input.monthlyLimit - input.monthlyUsed - requested, 0),
  };
}
