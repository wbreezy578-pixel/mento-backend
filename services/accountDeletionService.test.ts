import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const prisma = {
    accountDeletionJob: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    user: { findUnique: vi.fn(), delete: vi.fn() },
    userWallet: { findUnique: vi.fn() },
    session: { updateMany: vi.fn() },
    paymentTransaction: { findMany: vi.fn(), updateMany: vi.fn() },
    paymentReceipt: { updateMany: vi.fn() },
    paymentLedgerEntry: { updateMany: vi.fn() },
    storePurchase: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    prisma,
    deleteSupabaseAuthUser: vi.fn(),
  };
});

vi.mock('../lib/prisma', () => ({ prisma: mocks.prisma }));
vi.mock('./supabaseAdminService', () => ({ deleteSupabaseAuthUser: mocks.deleteSupabaseAuthUser }));
vi.mock('../lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { processAccountDeletionJob } from './accountDeletionService';

const job = {
  id: 'deletion-job-a',
  userId: 'user-a',
  supabaseUserId: 'supabase-a',
  paddleSubscriptionId: 'sub-a',
  paddleCanceledAt: null,
  googlePlayCanceledAt: null,
  supabaseDeletedAt: null,
  completedAt: null,
  status: 'PENDING',
  attempts: 1,
  updatedAt: new Date('2026-08-20T00:00:00.000Z'),
};

describe('durable account deletion retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (operation: (tx: typeof mocks.prisma) => unknown) => operation(mocks.prisma));
    mocks.prisma.accountDeletionJob.findUniqueOrThrow.mockResolvedValue(job);
    mocks.prisma.accountDeletionJob.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.accountDeletionJob.update.mockResolvedValue(job);
    mocks.prisma.user.findUnique.mockResolvedValue({ id: 'user-a' });
    mocks.prisma.user.delete.mockResolvedValue({ id: 'user-a' });
    mocks.prisma.session.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.paymentTransaction.findMany.mockResolvedValue([]);
    mocks.prisma.paymentReceipt.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.paymentLedgerEntry.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.storePurchase.updateMany.mockResolvedValue({ count: 0 });
    mocks.deleteSupabaseAuthUser.mockResolvedValue(undefined);
  });

  it('deletes Mento data without cancelling the separate Google Play subscription', async () => {
    await expect(processAccountDeletionJob('deletion-job-a')).resolves.toEqual(job);
    expect(mocks.deleteSupabaseAuthUser).toHaveBeenCalledWith('supabase-a');
    expect(mocks.prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'user-a' } });
  });
});
