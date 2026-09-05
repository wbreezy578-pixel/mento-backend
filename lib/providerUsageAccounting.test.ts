import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Gemini usage accounting integration', () => {
  it('passes provider usage from normal chat generation into billing finalization', () => {
    for (const route of [
      'app/api/chat/route.ts',
      'app/api/chat/stream/route.ts',
      'app/api/chat/message/regenerate/route.ts',
      'app/api/images/analyze/route.ts',
    ]) {
      expect(source(route)).toContain('reportUsage');
    }

    const gateway = source('lib/aiSecurityGateway.ts');
    expect(gateway).toContain('tokensInput: effectiveUsage?.inputTokens ?? 0');
    expect(gateway).toContain('tokensThinking: effectiveUsage?.thinkingTokens ?? 0');
    expect(gateway).toContain("usageSource: attemptAccounting?.usageSource ?? effectiveUsage?.source ?? 'UNKNOWN'");
    expect(gateway).toContain('providerExposureUSD: attemptAccounting?.providerExposureUSD');
    expect(source('services/billingService.ts')).toContain('assertAndLockGeminiDailyBudget(tx');
    expect(gateway).toContain('await options.beforeFinalize?.(result)');
  });

  it('persists the complete usage breakdown and computed economics', () => {
    const billing = source('services/billingService.ts');
    for (const field of ['tokensInput', 'tokensOutput', 'tokensCached', 'tokensThinking']) {
      expect(billing).toContain(`${field}: validatedInput.${field}`);
    }
    expect(billing).toContain("validatedInput.usageSource === 'UNKNOWN' ? existing.tokensTotal : validatedInput.tokensTotal");
    expect(billing).toContain('providerCostUSD,');
    expect(billing).toContain('providerExposureUSD: validatedInput.providerExposureUSD');
    expect(billing).toContain("validatedInput.usageSource === 'PROVIDER_REPORTED'");
  });

  it('keeps reservation, finalization and rollback inside one idempotent operation', () => {
    const gateway = source('lib/aiSecurityGateway.ts');
    const reserve = gateway.indexOf('billingDecision = await reserveAIUsage({');
    const provider = gateway.indexOf('const result = await options.callback({');
    const persist = gateway.indexOf('await options.beforeFinalize?.(result)');
    const finalize = gateway.indexOf('await finalizeAIUsage({');
    const rollback = gateway.indexOf('await rollbackAIUsage({');
    expect(reserve).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(reserve);
    expect(persist).toBeGreaterThan(provider);
    expect(finalize).toBeGreaterThan(persist);
    expect(rollback).toBeGreaterThan(finalize);

    const schema = source('prisma/schema.prisma');
    expect(schema).toContain('@@unique([provider, requestId])');
    expect(source('services/billingService.ts')).toContain("if (existing.success === true)");
  });

  it('retains known provider expense when a stream fails after producing billable work', () => {
    const gateway = source('lib/aiSecurityGateway.ts');
    const billing = source('services/billingService.ts');
    const gemini = source('services/geminiService.ts');

    expect(gemini).toContain('if (emittedTokenForModel || usageMetadata)');
    expect(gemini).toContain('onUsage?.(normalizeGeminiUsage(model, usageMetadata))');
    expect(gateway).toContain('if (providerAttemptCount > 0 || providerUsage)');
    expect(gateway).toContain('await reconcileProviderFailureUsage({');
    expect(gateway).toContain('providerExposureUSD: attemptAccounting?.providerExposureUSD');
    expect(gateway.indexOf('await reconcileProviderFailureUsage({')).toBeLessThan(gateway.indexOf('await rollbackAIUsage({'));
    expect(billing).toContain("reconcileNonCompletedUsage(input, 'provider_failed')");
    expect(billing).toContain("outcome === 'provider_failed'");
  });
});
