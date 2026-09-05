import type { AIProviderUsage } from '../lib/aiSecurityGateway';
import { getGeminiDailyBudgetPolicy } from './geminiDailyBudget';
import { calculateGeminiProviderCostUSD, isSupportedNormalChatModel } from './geminiPricing';

export type GeminiAttemptUsage = { attemptNumber: number; usage: AIProviderUsage };

export function buildGeminiAttemptAccounting(attemptCount: number, reports: GeminiAttemptUsage[]) {
  const byAttempt = new Map<number, AIProviderUsage>();
  for (const report of reports) {
    if (report.attemptNumber > 0 && report.attemptNumber <= attemptCount) {
      byAttempt.set(report.attemptNumber, report.usage);
    }
  }
  let actualProviderCostUSD = 0;
  let resolvedAttempts = 0;
  for (const usage of byAttempt.values()) {
    if (usage.source !== 'PROVIDER_REPORTED') continue;
    if (!isSupportedNormalChatModel(usage.model)) {
      throw new Error('Cannot price unsupported Gemini attempt usage.');
    }
    actualProviderCostUSD += calculateGeminiProviderCostUSD({
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens ?? 0,
      thinkingTokens: usage.thinkingTokens ?? 0,
    });
    resolvedAttempts += 1;
  }
  const unresolvedAttempts = Math.max(0, attemptCount - resolvedAttempts);
  const policy = getGeminiDailyBudgetPolicy();
  const orderedReports = [...byAttempt.entries()].sort(([a], [b]) => a - b);
  return {
    attemptCount,
    resolvedAttempts,
    unresolvedAttempts,
    actualProviderCostUSD,
    providerExposureUSD: unresolvedAttempts * policy.requestCostReservationUSD,
    usageSource: attemptCount === 0 || unresolvedAttempts > 0 ? 'UNKNOWN' as const : 'PROVIDER_REPORTED' as const,
    latestUsage: orderedReports.at(-1)?.[1],
    attemptTelemetry: orderedReports.map(([attemptNumber, usage]) => ({
      attemptNumber,
      model: usage.model,
      usageSource: usage.source,
    })),
  };
}
