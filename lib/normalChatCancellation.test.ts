import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeGeminiUsage } from '../services/geminiService';

function source(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Normal Chat cancellation lifecycle', () => {
  it('retains provider-reported usage on cancellation and leaves missing metadata unknown', () => {
    expect(normalizeGeminiUsage('gemini-3.5-flash-lite', {
      promptTokenCount: 12,
      candidatesTokenCount: 4,
      cachedContentTokenCount: 2,
      thoughtsTokenCount: 1,
      totalTokenCount: 17,
    })).toMatchObject({
      source: 'PROVIDER_REPORTED',
      inputTokens: 12,
      outputTokens: 4,
      cachedTokens: 2,
      thinkingTokens: 1,
      totalTokens: 17,
    });
    expect(normalizeGeminiUsage('gemini-3.5-flash-lite')).toMatchObject({
      source: 'UNKNOWN',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('returns an explicit cancelled outcome before and after partial output', () => {
    const gemini = source('services/geminiService.ts');
    expect(gemini).toContain("outcome: 'completed' | 'cancelled'");
    expect(gemini).toContain("return { outcome: 'cancelled', text: '', usage }");
    expect(gemini).toContain("return { outcome: 'cancelled', text: completionText.trim(), usage }");
    expect(gemini).toContain("return { outcome: 'completed', text: completionText.trim(), usage }");
  });

  it('never persists a cancelled partial as a completed assistant response', () => {
    const route = source('app/api/chat/stream/route.ts');
    const cancellationCheck = route.indexOf("generation.outcome === 'cancelled'");
    const successfulReturn = route.indexOf('return generation.text');
    expect(cancellationCheck).toBeGreaterThan(-1);
    expect(successfulReturn).toBeGreaterThan(cancellationCheck);
    expect(route).toContain("status: 'streaming'");
    expect(route).toContain('deleteMany({');
    expect(route).toContain("eventType: 'generation_cancelled'");
  });

  it('records real provider expense but releases completed-message allowance idempotently', () => {
    const billing = source('services/billingService.ts');
    expect(billing).toContain('export async function reconcileCancelledUsage');
    expect(billing).toContain("generationOutcome: 'cancelled'");
    expect(billing).toContain('providerCostUSD,');
    expect(billing).toContain('userChargeUSD: 0');
    expect(billing).toContain('profitUSD: -providerCostUSD');
    expect(billing).toContain('success: false');
    expect(billing).toContain('const alreadyReconciled =');
    expect(billing).toContain("'Non-completed reservation cannot be finalized.'");
    expect(source('prisma/schema.prisma')).toContain('@@unique([provider, requestId])');
  });

  it('keeps normal success and generation-lock cleanup unchanged', () => {
    for (const routePath of [
      'app/api/chat/stream/route.ts',
      'app/api/chat/message/regenerate/route.ts',
    ]) {
      const route = source(routePath);
      expect(route).toContain("type: 'done'");
      expect(route).toContain('finally {');
      expect(route).toContain('await releaseAIGenerationLock(');
    }
    const regenerate = source('app/api/chat/message/regenerate/route.ts');
    expect(regenerate).toContain('Keep the last completed answer intact.');
  });
});
