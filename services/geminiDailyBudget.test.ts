import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAndLockGeminiDailyBudget,
  GeminiDailyBudgetExceededError,
  GeminiDailyBudgetUnavailableError,
  getGeminiDailyBudgetPolicy,
  getGeminiDailyBudgetWindow,
} from './geminiDailyBudget';

type LedgerRow = {
  createdAt: Date;
  providerCostUSD: number;
  providerExposureUSD?: number;
  tokensTotal: number;
};

function transactionClient(rows: LedgerRow[], options?: { infrastructureFailure?: boolean }) {
  return {
    $queryRaw: vi.fn(async () => {
      if (options?.infrastructureFailure) throw new Error('database unavailable');
      return [{ pg_advisory_xact_lock: null }];
    }),
    usageLog: {
      aggregate: vi.fn(async (query: any) => {
        const active = rows.filter((row) => row.createdAt >= query.where.createdAt.gte);
        return { _sum: {
          providerCostUSD: active.reduce((total, row) => total + row.providerCostUSD, 0),
          providerExposureUSD: active.reduce((total, row) => total + (row.providerExposureUSD ?? 0), 0),
          tokensTotal: active.reduce((total, row) => total + row.tokensTotal, 0),
        } };
      }),
    },
  };
}

const policy = {
  costLimitUSD: 10,
  tokenLimit: 1_000,
  requestCostReservationUSD: 0.5,
  requestTokenReservation: 100,
};

describe('Gemini provider-wide daily budget', () => {
  it('allows a request below budget and reserves estimated exposure', async () => {
    const tx = transactionClient([{ createdAt: new Date('2026-08-31T01:00:00Z'), providerCostUSD: 2, tokensTotal: 200 }]);
    const result = await assertAndLockGeminiDailyBudget(tx as any, {
      requestId: 'request-below-budget', policy, now: new Date('2026-08-31T12:00:00Z'),
    });
    expect(result).toMatchObject({ reservationCostUSD: 0.5, reservationTokens: 100 });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
    expect(tx.$queryRaw.mock.calls[0][0].join('')).toContain('::text');
  });

  it('blocks before the provider when projected spend exceeds the boundary', async () => {
    const tx = transactionClient([{ createdAt: new Date('2026-08-31T01:00:00Z'), providerCostUSD: 9.75, tokensTotal: 500 }]);
    await expect(assertAndLockGeminiDailyBudget(tx as any, {
      requestId: 'request-at-budget', policy, now: new Date('2026-08-31T12:00:00Z'),
    })).rejects.toBeInstanceOf(GeminiDailyBudgetExceededError);
  });

  it('counts unresolved provider exposure so repeated cancellation cannot recycle budget', async () => {
    const tx = transactionClient([{
      createdAt: new Date('2026-08-31T01:00:00Z'),
      providerCostUSD: 0,
      providerExposureUSD: 9.75,
      tokensTotal: 500,
    }]);
    await expect(assertAndLockGeminiDailyBudget(tx as any, {
      requestId: 'request-after-cancellations', policy, now: new Date('2026-08-31T12:00:00Z'),
    })).rejects.toBeInstanceOf(GeminiDailyBudgetExceededError);
  });

  it('fails closed when the database lock or accounting query is unavailable', async () => {
    const tx = transactionClient([], { infrastructureFailure: true });
    await expect(assertAndLockGeminiDailyBudget(tx as any, {
      requestId: 'request-db-failure', policy,
    })).rejects.toBeInstanceOf(GeminiDailyBudgetUnavailableError);
  });

  it('resets at UTC midnight and ignores the previous period', async () => {
    const tx = transactionClient([{ createdAt: new Date('2026-08-30T23:59:59Z'), providerCostUSD: 10, tokensTotal: 1_000 }]);
    await expect(assertAndLockGeminiDailyBudget(tx as any, {
      requestId: 'request-new-day', policy, now: new Date('2026-08-31T00:00:01Z'),
    })).resolves.toMatchObject({ reservationCostUSD: 0.5 });
    expect(getGeminiDailyBudgetWindow(new Date('2026-08-31T12:00:00Z')).reset.toISOString())
      .toBe('2026-09-01T00:00:00.000Z');
  });

  it('serializes reservations shared by multiple backend instances', async () => {
    const rows: LedgerRow[] = [{ createdAt: new Date('2026-08-31T01:00:00Z'), providerCostUSD: 9, tokensTotal: 500 }];
    let queue = Promise.resolve();
    async function acrossReplica(requestId: string) {
      const prior = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        const reservation = await assertAndLockGeminiDailyBudget(transactionClient(rows) as any, {
          requestId, policy, now: new Date('2026-08-31T12:00:00Z'),
        });
        rows.push({
          createdAt: new Date('2026-08-31T12:00:00Z'),
          providerCostUSD: 0,
          providerExposureUSD: reservation.reservationCostUSD,
          tokensTotal: reservation.reservationTokens,
        });
        return 'allowed';
      } finally {
        release();
      }
    }
    const results = await Promise.allSettled([
      acrossReplica('replica-a'), acrossReplica('replica-b'), acrossReplica('replica-c'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(rows.reduce((total, row) => total + row.providerCostUSD + (row.providerExposureUSD ?? 0), 0)).toBe(10);
  });

  it('keeps limits and reservation exposure in one server-side policy', () => {
    expect(getGeminiDailyBudgetPolicy({
      AI_DAILY_COST_LIMIT_USD: '20',
      AI_DAILY_TOKEN_LIMIT: '2000000',
      AI_GEMINI_REQUEST_COST_RESERVATION_USD: '0.75',
      AI_GEMINI_REQUEST_TOKEN_RESERVATION: '120000',
    } as NodeJS.ProcessEnv)).toEqual({
      costLimitUSD: 20,
      tokenLimit: 2_000_000,
      requestCostReservationUSD: 0.75,
      requestTokenReservation: 120_000,
    });
  });
});

describe('Normal Chat Gemini budget boundary coverage', () => {
  const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

  it('routes every user-triggered Normal Chat Gemini entry through executeAIRequest', () => {
    for (const route of [
      'app/api/chat/route.ts',
      'app/api/chat/stream/route.ts',
      'app/api/chat/message/regenerate/route.ts',
      'app/api/images/analyze/route.ts',
    ]) {
      const code = source(route);
      expect(code).toContain('executeAIRequest({');
      expect(code).toContain("provider: 'Gemini'");
      const providerCall = Math.max(code.indexOf('askGemini('), code.indexOf('askGeminiStream('), code.indexOf('analyzeImage('));
      expect(providerCall).toBeGreaterThan(code.indexOf('executeAIRequest({'));
    }
  });

  it('checks and reserves atomically before provider callback execution', () => {
    const billing = source('services/billingService.ts');
    const gateway = source('lib/aiSecurityGateway.ts');
    expect(billing.indexOf('assertAndLockGeminiDailyBudget(tx')).toBeLessThan(billing.indexOf('const successRecord = await createUsageLedgerEntry('));
    expect(gateway.indexOf('billingDecision = await reserveAIUsage({')).toBeLessThan(gateway.indexOf('const result = await options.callback({'));
    expect(source('services/geminiService.ts')).not.toContain('reserveAIUsage');
  });

  it('uses one reservation for provider retries and model fallback', () => {
    const gateway = source('lib/aiSecurityGateway.ts');
    const gemini = source('services/geminiService.ts');
    expect(gateway.match(/reserveAIUsage\(\{/g)).toHaveLength(1);
    expect(gemini).toContain('for (const model of candidates)');
    expect(gemini).not.toContain('assertAndLockGeminiDailyBudget');
  });

  it('does not perform an unreserved billable Gemini generation during server startup', () => {
    expect(source('server.ts')).not.toContain('runGeminiStartupHealthCheck');
  });
});
