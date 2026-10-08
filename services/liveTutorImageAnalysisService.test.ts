import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { acquireLiveTutorImageQuotaLock } from './liveTutorImageAnalysisService';

describe('Live Tutor image quota lock', () => {
  it('casts PostgreSQL void advisory-lock result to text for Prisma deserialization', async () => {
    const queryRaw = vi.fn(async () => [{ pg_advisory_xact_lock: '' }]);
    const transaction = { $queryRaw: queryRaw as unknown as Prisma.TransactionClient['$queryRaw'] } as Prisma.TransactionClient;

    await acquireLiveTutorImageQuotaLock(transaction, 'user-123', '2026-09-27');

    const [queryParts, userId, dayKey] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, string, string];
    expect(queryParts.join('')).toContain('pg_advisory_xact_lock');
    expect(queryParts.join('')).toContain('::text');
    expect([userId, dayKey]).toEqual(['user-123', '2026-09-27']);
  });
});