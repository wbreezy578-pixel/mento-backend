import { describe, expect, it } from 'vitest';
import { buildGeminiAttemptAccounting } from './geminiAttemptAccounting';
import { calculateGeminiProviderCostUSD } from './geminiPricing';

const reported = (model = 'gemini-3.5-flash-lite') => ({
  model,
  inputTokens: 1_000,
  outputTokens: 200,
  cachedTokens: 100,
  thinkingTokens: 25,
  totalTokens: 1_225,
  source: 'PROVIDER_REPORTED' as const,
});

describe('Gemini provider-attempt accounting', () => {
  it('releases exposure only when Gemini was never invoked', () => {
    expect(buildGeminiAttemptAccounting(0, [])).toMatchObject({
      attemptCount: 0,
      actualProviderCostUSD: 0,
      providerExposureUSD: 0,
      usageSource: 'UNKNOWN',
    });
  });

  it('retains conservative exposure without fabricating usage for an invoked attempt', () => {
    const result = buildGeminiAttemptAccounting(1, []);
    expect(result).toMatchObject({
      attemptCount: 1,
      resolvedAttempts: 0,
      unresolvedAttempts: 1,
      actualProviderCostUSD: 0,
      providerExposureUSD: 0.5,
      usageSource: 'UNKNOWN',
      latestUsage: undefined,
    });
  });

  it('uses authoritative cost and releases exposure when metadata is reported', () => {
    const usage = reported();
    const result = buildGeminiAttemptAccounting(1, [{ attemptNumber: 1, usage }]);
    expect(result.actualProviderCostUSD).toBe(calculateGeminiProviderCostUSD({
      model: 'gemini-3.5-flash-lite',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      thinkingTokens: usage.thinkingTokens,
    }));
    expect(result).toMatchObject({
      resolvedAttempts: 1,
      unresolvedAttempts: 0,
      providerExposureUSD: 0,
      usageSource: 'PROVIDER_REPORTED',
    });
  });

  it('accounts a failed unknown attempt and a successful retry separately', () => {
    const usage = reported();
    const result = buildGeminiAttemptAccounting(2, [{ attemptNumber: 2, usage }]);
    expect(result.actualProviderCostUSD).toBeGreaterThan(0);
    expect(result).toMatchObject({
      attemptCount: 2,
      resolvedAttempts: 1,
      unresolvedAttempts: 1,
      providerExposureUSD: 0.5,
      usageSource: 'UNKNOWN',
    });
  });

  it('accounts fallback attempts and does not double count duplicate reports', () => {
    const first = reported('gemini-3.5-flash');
    const fallback = reported('gemini-3.5-flash-lite');
    const result = buildGeminiAttemptAccounting(2, [
      { attemptNumber: 1, usage: first },
      { attemptNumber: 1, usage: first },
      { attemptNumber: 2, usage: fallback },
    ]);
    const expected = calculateGeminiProviderCostUSD({
      model: 'gemini-3.5-flash', inputTokens: 1_000, outputTokens: 200, cachedTokens: 100, thinkingTokens: 25,
    }) + calculateGeminiProviderCostUSD({
      model: 'gemini-3.5-flash-lite', inputTokens: 1_000, outputTokens: 200, cachedTokens: 100, thinkingTokens: 25,
    });
    expect(result.actualProviderCostUSD).toBe(expected);
    expect(result.attemptTelemetry).toHaveLength(2);
    expect(result.providerExposureUSD).toBe(0);
  });

  it('rejects provider-reported usage for an unsupported model', () => {
    expect(() => buildGeminiAttemptAccounting(1, [{
      attemptNumber: 1,
      usage: reported('gemini-unknown'),
    }])).toThrow('Cannot price unsupported Gemini attempt usage.');
  });
});
