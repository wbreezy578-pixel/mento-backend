import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import { getProductPolicy, getUtcDayWindow, getFreeMonthlyWindow, type CanonicalPlanName } from './productPolicy';
import { isSubscriptionActive } from './planService';

export type EntitlementProvider = 'SYSTEM' | 'ADMIN' | 'PADDLE' | 'GOOGLE_PLAY' | 'APPLE_APP_STORE';
export type CanonicalEntitlementStatus = 'ACTIVE' | 'GRACE_PERIOD' | 'CANCELLED' | 'EXPIRED' | 'REVOKED' | 'ON_HOLD';

export interface CanonicalEntitlement {
  plan: CanonicalPlanName;
  status: CanonicalEntitlementStatus;
  source: EntitlementProvider;
  periodStart: Date | null;
  periodEnd: Date | null;
  policy: ReturnType<typeof getProductPolicy>;
}

export function shouldApplyEntitlementEvent(currentUpdatedAt: Date | null | undefined, incomingOccurredAt: Date): boolean {
  return !currentUpdatedAt || incomingOccurredAt.getTime() > currentUpdatedAt.getTime();
}

export function resolveIncludedSecondsForEvent(input: {
  grantsAccess: boolean;
  allowanceSeconds: number;
  previousIncludedSeconds: number | null;
  previousPeriodStart: Date | null;
  previousPeriodEnd: Date | null;
  incomingPeriodStart: Date | null;
  incomingPeriodEnd: Date | null;
}): number {
  if (!input.grantsAccess) return 0;
  const samePeriod = Boolean(
    input.previousPeriodStart
    && input.previousPeriodEnd
    && input.incomingPeriodStart
    && input.incomingPeriodEnd
    && input.previousPeriodStart.getTime() === input.incomingPeriodStart.getTime()
    && input.previousPeriodEnd.getTime() === input.incomingPeriodEnd.getTime(),
  );
  return samePeriod && input.previousIncludedSeconds !== null
    ? input.previousIncludedSeconds
    : input.allowanceSeconds;
}

function canonicalStatus(raw: string | null | undefined): CanonicalEntitlementStatus {
  switch (String(raw ?? '').toLowerCase()) {
    case 'active': case 'trialing': return 'ACTIVE';
    case 'grace': case 'grace_period': return 'GRACE_PERIOD';
    case 'canceled': case 'cancelled': return 'CANCELLED';
    case 'revoked': case 'refunded': return 'REVOKED';
    case 'past_due': case 'paused': case 'on_hold': return 'ON_HOLD';
    default: return 'EXPIRED';
  }
}

export async function getCanonicalEntitlement(userId: string, now = new Date()): Promise<CanonicalEntitlement> {
  const wallet = await prisma.userWallet.findUnique({ where: { userId }, include: { plan: true } });
  const paidAccess = Boolean(wallet?.plan.name === 'PRO' && isSubscriptionActive(
    wallet.subscriptionStatus,
    wallet.subscriptionExpiresAt,
    wallet.subscriptionPeriodStart ?? wallet.subscriptionStartedAt,
    now,
  ));
  const plan: CanonicalPlanName = paidAccess ? 'PRO' : 'FREE';
  const rawStatus = wallet ? canonicalStatus(wallet.subscriptionStatus) : 'ACTIVE';
  return {
    plan,
    status: paidAccess ? rawStatus : (wallet?.plan.name === 'PRO' ? 'EXPIRED' : 'ACTIVE'),
    source: (wallet?.entitlementSource as EntitlementProvider | undefined) ?? 'SYSTEM',
    periodStart: paidAccess ? wallet?.subscriptionPeriodStart ?? wallet?.subscriptionStartedAt ?? null : getFreeMonthlyWindow(now).start,
    periodEnd: paidAccess ? wallet?.subscriptionExpiresAt ?? null : getFreeMonthlyWindow(now).end,
    policy: getProductPolicy(plan),
  };
}

export async function getEntitlementSnapshot(userId: string, now = new Date()) {
  const entitlement = await getCanonicalEntitlement(userId, now);
  const day = getUtcDayWindow(now);
  const month = entitlement.plan === 'PRO' && entitlement.periodStart && entitlement.periodEnd
    ? { start: entitlement.periodStart, end: entitlement.periodEnd }
    : getFreeMonthlyWindow(now);
  const [dailyChat, monthlyChat, dailyImages, liveWallet] = await Promise.all([
    prisma.usageLog.count({ where: { userId, feature: 'chat', success: true, createdAt: { gte: day.start, lt: day.end } } }),
    prisma.usageLog.count({ where: { userId, feature: 'chat', success: true, createdAt: { gte: month.start, lt: month.end } } }),
    prisma.usageLog.count({ where: { userId, feature: 'image', success: true, createdAt: { gte: day.start, lt: day.end } } }),
    prisma.liveTutorWallet.findUnique({ where: { userId } }),
  ]);
  return {
    plan: entitlement.plan,
    status: entitlement.status,
    source: entitlement.source,
    periodStart: entitlement.periodStart,
    periodEnd: entitlement.periodEnd,
    normalChat: {
      modelPolicy: entitlement.policy.normalChat.model,
      dailyRemaining: Math.max(entitlement.policy.normalChat.dailyCompletedMessages - dailyChat, 0),
      monthlyRemaining: Math.max(entitlement.policy.normalChat.monthlyCompletedMessages - monthlyChat, 0),
      dailyResetAt: day.end,
      monthlyResetAt: month.end,
    },
    images: {
      dailyRemaining: Math.max(entitlement.policy.normalChat.imageQuestionsPerDay - dailyImages, 0),
      resetAt: day.end,
    },
    liveTutor: {
      allowed: entitlement.policy.liveTutor.enabled,
      includedSecondsRemaining: liveWallet?.includedSeconds ?? 0,
      topUpSecondsRemaining: liveWallet?.topUpSeconds ?? 0,
      maxConcurrentSessions: entitlement.policy.liveTutor.maxConcurrentSessions,
      maxSessionSeconds: entitlement.policy.liveTutor.maxSessionSeconds,
    },
  };
}

async function lockLiveWallet(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT id FROM "LiveTutorWallet" WHERE "userId" = ${userId} FOR UPDATE`;
}

export async function creditLiveTutorTopUp(input: {
  userId: string;
  seconds: number;
  idempotencyKey: string;
  source: EntitlementProvider;
  expiresAt: Date | null;
}) {
  if (!Number.isSafeInteger(input.seconds) || input.seconds <= 0) throw new Error('Top-up seconds must be a positive integer.');
  if (!input.idempotencyKey.trim()) throw new Error('Top-up idempotency key is required.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.liveTutorMinuteLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { duplicate: true, includedSeconds: existing.includedSecondsAfter, topUpSeconds: existing.topUpSecondsAfter };
    await tx.liveTutorWallet.upsert({ where: { userId: input.userId }, update: {}, create: { userId: input.userId } });
    await lockLiveWallet(tx, input.userId);
    const wallet = await tx.liveTutorWallet.update({ where: { userId: input.userId }, data: {
      topUpSeconds: { increment: input.seconds }, minutesBalance: { increment: Math.ceil(input.seconds / 60) },
    } });
    await tx.liveTutorMinuteLedger.create({ data: {
      userId: input.userId, walletId: wallet.id, idempotencyKey: input.idempotencyKey,
      entryType: 'TOP_UP_CREDIT', source: input.source, topUpSecondsDelta: input.seconds,
      includedSecondsAfter: wallet.includedSeconds, topUpSecondsAfter: wallet.topUpSeconds,
      expiresAt: input.expiresAt,
    } });
    return { duplicate: false, includedSeconds: wallet.includedSeconds, topUpSeconds: wallet.topUpSeconds };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function allocateLiveTutorConsumption(includedSeconds: number, topUpSeconds: number, requestedSeconds: number) {
  if (![includedSeconds, topUpSeconds, requestedSeconds].every(Number.isSafeInteger) || includedSeconds < 0 || topUpSeconds < 0 || requestedSeconds <= 0) {
    throw new Error('Live Tutor balances and requested seconds are invalid.');
  }
  if (includedSeconds + topUpSeconds < requestedSeconds) throw new Error('Live Tutor allowance exhausted.');
  const includedUsed = Math.min(includedSeconds, requestedSeconds);
  return { includedUsed, topUpUsed: requestedSeconds - includedUsed };
}

export async function consumeLiveTutorEntitlement(input: { userId: string; seconds: number; idempotencyKey: string }) {
  if (!Number.isSafeInteger(input.seconds) || input.seconds <= 0) throw new Error('Consumption seconds must be a positive integer.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.liveTutorMinuteLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { duplicate: true, includedSeconds: existing.includedSecondsAfter, topUpSeconds: existing.topUpSecondsAfter };
    await tx.liveTutorWallet.upsert({ where: { userId: input.userId }, update: {}, create: { userId: input.userId } });
    await lockLiveWallet(tx, input.userId);
    const wallet = await tx.liveTutorWallet.findUniqueOrThrow({ where: { userId: input.userId } });
    const { includedUsed, topUpUsed } = allocateLiveTutorConsumption(wallet.includedSeconds, wallet.topUpSeconds, input.seconds);
    const updated = await tx.liveTutorWallet.update({ where: { userId: input.userId }, data: {
      includedSeconds: { decrement: includedUsed }, topUpSeconds: { decrement: topUpUsed },
      minutesBalance: Math.floor((wallet.includedSeconds + wallet.topUpSeconds - input.seconds) / 60),
    } });
    await tx.liveTutorMinuteLedger.create({ data: {
      userId: input.userId, walletId: wallet.id, idempotencyKey: input.idempotencyKey,
      entryType: 'CONSUMPTION', source: 'SYSTEM', includedSecondsDelta: -includedUsed, topUpSecondsDelta: -topUpUsed,
      includedSecondsAfter: updated.includedSeconds, topUpSecondsAfter: updated.topUpSeconds,
    } });
    return { duplicate: false, includedSeconds: updated.includedSeconds, topUpSeconds: updated.topUpSeconds };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * Internal provider-adapter boundary. Callers must verify provider signatures
 * and purchase ownership before constructing this server-only command.
 */
export async function applyVerifiedEntitlementEvent(input: {
  userId: string;
  provider: EntitlementProvider;
  externalEventId: string;
  externalTransactionId?: string;
  eventType: string;
  plan: CanonicalPlanName;
  status: CanonicalEntitlementStatus;
  periodStart: Date | null;
  periodEnd: Date | null;
  occurredAt: Date;
}) {
  if (!input.externalEventId.trim()) throw new Error('Provider event identity is required.');
  if (!Number.isFinite(input.occurredAt.getTime())) throw new Error('Provider event timestamp is invalid.');
  if (input.plan === 'PRO' && input.status !== 'REVOKED' && input.status !== 'EXPIRED' && (!input.periodStart || !input.periodEnd || input.periodEnd <= input.periodStart)) {
    throw new Error('A valid subscription period is required for Pro access.');
  }
  return prisma.$transaction(async (tx) => {
    const existing = await tx.entitlementEvent.findUnique({ where: { provider_externalEventId: { provider: input.provider, externalEventId: input.externalEventId } } });
    if (existing) {
      if (existing.userId !== input.userId) throw new Error('Entitlement event ownership conflict.');
      recordEntitlementTelemetry('duplicate_entitlement_event', { provider: input.provider, eventType: input.eventType });
      return { duplicate: true };
    }
    const plan = await tx.plan.findUniqueOrThrow({ where: { name: input.plan } });
    await tx.entitlementEvent.create({ data: {
      userId: input.userId, provider: input.provider, externalEventId: input.externalEventId,
      externalTransactionId: input.externalTransactionId, eventType: input.eventType,
      planName: input.plan, status: input.status, periodStart: input.periodStart,
      periodEnd: input.periodEnd, occurredAt: input.occurredAt,
    } });
    const currentWallet = await tx.userWallet.findUnique({ where: { userId: input.userId } });
    // Provider events are durable audit evidence even when stale, but only a
    // strictly newer event may mutate canonical entitlement state.
    if (!shouldApplyEntitlementEvent(currentWallet?.entitlementUpdatedAt, input.occurredAt)) {
      recordEntitlementTelemetry('duplicate_entitlement_event', {
        provider: input.provider,
        eventType: input.eventType,
        stale: true,
      });
      return { duplicate: false, stale: true };
    }
    const grantsAccess = input.plan === 'PRO' && (input.status === 'ACTIVE' || input.status === 'GRACE_PERIOD' || input.status === 'CANCELLED');
    const status = input.status.toLowerCase();
    await tx.userWallet.upsert({ where: { userId: input.userId }, update: {
      planId: grantsAccess ? plan.id : (await tx.plan.findUniqueOrThrow({ where: { name: 'FREE' } })).id,
      subscriptionStatus: status,
      subscriptionStartedAt: input.periodStart,
      subscriptionPeriodStart: input.periodStart,
      subscriptionExpiresAt: input.periodEnd,
      entitlementSource: input.provider,
      entitlementExternalId: input.externalTransactionId,
      entitlementUpdatedAt: input.occurredAt,
    }, create: {
      userId: input.userId, planId: grantsAccess ? plan.id : (await tx.plan.findUniqueOrThrow({ where: { name: 'FREE' } })).id,
      subscriptionStatus: status, subscriptionStartedAt: input.periodStart,
      subscriptionPeriodStart: input.periodStart, subscriptionExpiresAt: input.periodEnd,
      entitlementSource: input.provider, entitlementExternalId: input.externalTransactionId,
      entitlementUpdatedAt: input.occurredAt,
    } });
    const livePolicy = getProductPolicy(grantsAccess ? 'PRO' : 'FREE').liveTutor;
    const previousLiveWallet = await tx.liveTutorWallet.findUnique({ where: { userId: input.userId } });
    const retainedTopUpSeconds = previousLiveWallet?.topUpSeconds ?? 0;
    // Status updates within one billing period must not refill minutes already
    // consumed. Only a genuinely new verified period receives the allowance.
    const nextIncludedSeconds = resolveIncludedSecondsForEvent({
      grantsAccess,
      allowanceSeconds: livePolicy.includedSecondsPerPeriod,
      previousIncludedSeconds: previousLiveWallet?.includedSeconds ?? null,
      previousPeriodStart: previousLiveWallet?.includedPeriodStart ?? null,
      previousPeriodEnd: previousLiveWallet?.includedPeriodEnd ?? null,
      incomingPeriodStart: input.periodStart,
      incomingPeriodEnd: input.periodEnd,
    });
    const liveWallet = await tx.liveTutorWallet.upsert({ where: { userId: input.userId }, update: {
      includedSeconds: nextIncludedSeconds,
      minutesBalance: Math.floor((nextIncludedSeconds + retainedTopUpSeconds) / 60),
      includedPeriodStart: grantsAccess ? input.periodStart : null,
      includedPeriodEnd: grantsAccess ? input.periodEnd : null,
    }, create: {
      userId: input.userId, includedSeconds: nextIncludedSeconds,
      minutesBalance: Math.floor(nextIncludedSeconds / 60),
      includedPeriodStart: grantsAccess ? input.periodStart : null,
      includedPeriodEnd: grantsAccess ? input.periodEnd : null,
    } });
    const ledgerKey = `entitlement:${input.provider}:${input.externalEventId}`;
    await tx.liveTutorMinuteLedger.create({ data: {
      userId: input.userId, walletId: liveWallet.id, idempotencyKey: ledgerKey,
      entryType: grantsAccess ? 'SUBSCRIPTION_PERIOD_RESET' : 'SUBSCRIPTION_REVOKED', source: input.provider,
      includedSecondsDelta: liveWallet.includedSeconds - (previousLiveWallet?.includedSeconds ?? 0), includedSecondsAfter: liveWallet.includedSeconds,
      topUpSecondsAfter: liveWallet.topUpSeconds, expiresAt: input.periodEnd,
    } });
    recordEntitlementTelemetry('entitlement_state_changed', { provider: input.provider, plan: grantsAccess ? 'PRO' : 'FREE', status: input.status });
    return { duplicate: false, stale: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function recordEntitlementTelemetry(event: 'entitlement_denied' | 'chat_allowance_exhausted' | 'live_allowance_exhausted' | 'duplicate_entitlement_event' | 'entitlement_state_changed' | 'usage_reservation_failed', metadata: Record<string, string | number | boolean | null>) {
  logger.info('Product entitlement event', { category: event, ...metadata });
}
