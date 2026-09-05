import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { cancelPaddleSubscriptionForAccountDeletion } from './paddleService';
import { cancelGooglePlaySubscriptionsForAccountDeletion } from './nativeStoreService';
import { deleteSupabaseAuthUser } from './supabaseAdminService';
import {
  type AccountDeletionFailureCode,
  isAccountDeletionJobStalled,
  isAccountDeletionRetryDue,
} from './accountDeletionPolicy';

export class AccountDeletionPendingError extends Error {
  constructor(public readonly jobId: string) {
    super('Account deletion is pending.');
    this.name = 'AccountDeletionPendingError';
  }
}

export async function beginAccountDeletion(userId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.accountDeletionJob.findUnique({ where: { userId } });
    if (existing) return existing;
    const [user, wallet] = await Promise.all([
      tx.user.findUnique({ where: { id: userId }, select: { id: true, supabaseUserId: true } }),
      tx.userWallet.findUnique({ where: { userId }, select: { paddleSubscriptionId: true } }),
    ]);
    if (!user) throw new Error('User not found');
    await tx.user.update({ where: { id: userId }, data: { accountStatus: 'DELETION_PENDING', credentialsChangedAt: new Date() } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return tx.accountDeletionJob.create({
      data: { userId, supabaseUserId: user.supabaseUserId, paddleSubscriptionId: wallet?.paddleSubscriptionId ?? null },
    });
  });
}

async function removeInternalAccountData(tx: Prisma.TransactionClient, userId: string, jobId: string) {
  const targetUser = await tx.user.findUnique({ where: { id: userId } });
  if (targetUser) {
    const succeededPayments = await tx.paymentTransaction.findMany({
      where: { userId, status: 'SUCCEEDED' },
      select: { id: true },
    });
    const preservedIds = succeededPayments.map(({ id }) => id);
    if (preservedIds.length > 0) {
      await tx.paymentTransaction.updateMany({ where: { id: { in: preservedIds } }, data: { userId: null, metadata: {} as Prisma.InputJsonValue, providerPayload: {} as Prisma.InputJsonValue } });
      await tx.paymentReceipt.updateMany({ where: { transactionId: { in: preservedIds } }, data: { userId: null, payload: {} as Prisma.InputJsonValue } });
      await tx.paymentLedgerEntry.updateMany({ where: { transactionId: { in: preservedIds } }, data: { userId: null, metadata: {} as Prisma.InputJsonValue } });
      await tx.storePurchase.updateMany({ where: { paymentTransactionId: { in: preservedIds } }, data: { userId: null, rawPayload: {} as Prisma.InputJsonValue } });
    }
    await tx.user.delete({ where: { id: userId } });
  }
  await tx.accountDeletionJob.update({ where: { id: jobId }, data: { status: 'COMPLETED', completedAt: new Date(), lastError: null } });
}

export async function processAccountDeletionJob(jobId: string) {
  const existing = await prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
  if (existing.completedAt) return existing;

  // A worker may reclaim a job only after the previous worker has had time to
  // finish. This prevents the API request and the scheduled retry worker from
  // cancelling provider subscriptions at the same time, while still allowing
  // recovery after a process crash.
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const claim = await prisma.accountDeletionJob.updateMany({
    where: {
      id: jobId,
      completedAt: null,
      OR: [
        { status: 'PENDING' },
        { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'PROCESSING', attempts: { increment: 1 }, lastError: null },
  });
  if (claim.count !== 1) throw new AccountDeletionPendingError(jobId);
  const job = await prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
  let failureCode: AccountDeletionFailureCode = 'internal_delete_failed';

  try {
    if (!job.paddleCanceledAt) {
      failureCode = 'paddle_cancel_failed';
      if (job.paddleSubscriptionId) await cancelPaddleSubscriptionForAccountDeletion(job.paddleSubscriptionId);
      await prisma.accountDeletionJob.update({ where: { id: job.id }, data: { paddleCanceledAt: new Date() } });
    }
    if (!job.googlePlayCanceledAt) {
      failureCode = 'google_play_cancel_failed';
      await cancelGooglePlaySubscriptionsForAccountDeletion(job.userId);
      await prisma.accountDeletionJob.update({ where: { id: job.id }, data: { googlePlayCanceledAt: new Date() } });
    }
    if (!job.supabaseDeletedAt) {
      failureCode = 'supabase_delete_failed';
      if (job.supabaseUserId) await deleteSupabaseAuthUser(job.supabaseUserId);
      await prisma.accountDeletionJob.update({ where: { id: job.id }, data: { supabaseDeletedAt: new Date() } });
    }
    failureCode = 'internal_delete_failed';
    await prisma.$transaction((tx) => removeInternalAccountData(tx, job.userId, job.id));
    return prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: job.id } });
  } catch (error) {
    logger.error('Durable account deletion attempt failed', {
      failureCode,
      errorName: error instanceof Error ? error.name : 'unknown',
      attempt: job.attempts,
    });
    await prisma.accountDeletionJob.update({
      where: { id: job.id },
      data: { status: 'PENDING', lastError: failureCode },
    }).catch(() => undefined);
    throw new AccountDeletionPendingError(job.id);
  }
}

export async function retryPendingAccountDeletions(limit = 20) {
  const now = new Date();
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const candidates = await prisma.accountDeletionJob.findMany({
    where: {
      completedAt: null,
      OR: [
        { status: 'PENDING' },
        { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: 100,
  });
  const jobs = candidates
    .filter((job) => isAccountDeletionRetryDue(job, now))
    .slice(0, Math.max(1, Math.min(limit, 100)));
  let completed = 0;
  for (const job of jobs) {
    try {
      await processAccountDeletionJob(job.id);
      completed += 1;
    } catch (error) {
      if (!(error instanceof AccountDeletionPendingError)) throw error;
    }
  }
  const pending = await prisma.accountDeletionJob.findMany({
    where: { completedAt: null },
    select: { attempts: true, createdAt: true },
  });
  const needsAttention = pending.filter((job) => isAccountDeletionJobStalled(job, now)).length;
  if (needsAttention > 0) {
    logger.warn('Account deletion jobs require operator attention', { needsAttention, pending: pending.length });
  }
  return {
    attempted: jobs.length,
    completed,
    pending: pending.length,
    needsAttention,
  };
}
