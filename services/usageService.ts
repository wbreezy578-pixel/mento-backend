import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getEffectiveLimit, getEffectivePlanForUser } from './planService';
import { reserveUsage } from './billingService';

export interface BillingDecision {
  allowed: boolean;
  reason: string;
  remainingUsage: number | null;
  resetTime: string | null;
  upgradeAvailable: boolean;
  modelUsed?: string | null;
  usage: UsageSnapshot;
}

export type UsageScope = 'day' | 'month' | 'rolling';
export type UsageFeature = 'chat' | 'image' | 'live_tutor';

export interface UsageSnapshot {
  feature: UsageFeature;
  scope: UsageScope;
  used: number;
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

export type UsageCheckResult = BillingDecision;

export interface UsageLogInput {
  userId: string;
  feature: UsageFeature;
  amount?: number;
  scope?: UsageScope;
  provider?: string;
  modelUsed?: string | null;
  requestId?: string;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

function normalizeReason(value: string | null | undefined): string {
  return value ?? 'Usage limit reached.';
}

function getResetTime(scope: UsageScope): Date {
  const now = new Date();
  if (scope === 'month') {
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  if (scope === 'rolling') {
    return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

function getWindowStart(scope: UsageScope): Date {
  const now = new Date();
  if (scope === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  if (scope === 'rolling') {
    return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function toUsageFeature(feature: UsageFeature): string {
  return feature === 'live_tutor' ? 'live_tutor' : feature;
}

function getDefaultProvider(feature: UsageFeature): string {
  if (feature === 'image') return 'ImageGen';
  if (feature === 'live_tutor') return 'Simli';
  return 'Gemini';
}

async function getUsageCount(userId: string, feature: UsageFeature, scope: UsageScope, windowStart?: Date): Promise<number> {
  const start = windowStart ?? getWindowStart(scope);
  return prisma.usageLog.count({
    where: {
      userId,
      feature: toUsageFeature(feature),
      createdAt: { gte: start },
    },
  });
}

export async function getUsage(userId: string, feature: UsageFeature, scope: UsageScope = 'day'): Promise<UsageSnapshot> {
  const plan = await getEffectivePlanForUser(userId);
  const windowStart = getWindowStart(scope);
  const resetAt = getResetTime(scope);
  const used = await getUsageCount(userId, feature, scope, windowStart);

  const limit = feature === 'chat' || feature === 'image' ? getEffectiveLimit(plan, feature) : null;
  const remaining = typeof limit === 'number' ? Math.max(limit - used, 0) : null;

  return {
    feature,
    scope,
    used,
    limit,
    remaining,
    resetAt,
  };
}

export async function remainingUsage(userId: string, feature: UsageFeature, scope: UsageScope = 'day'): Promise<number | null> {
  const snapshot = await getUsage(userId, feature, scope);
  return snapshot.remaining;
}

export async function resetTime(userId: string, feature: UsageFeature, scope: UsageScope = 'day'): Promise<Date | null> {
  const snapshot = await getUsage(userId, feature, scope);
  return snapshot.resetAt;
}

export async function isLimitReached(userId: string, feature: UsageFeature, amount = 1, scope: UsageScope = 'day'): Promise<boolean> {
  const snapshot = await getUsage(userId, feature, scope);
  if (feature === 'live_tutor') {
    const wallet = await prisma.liveTutorWallet.findUnique({ where: { userId } });
    return (wallet?.minutesBalance ?? 0) < amount;
  }

  if (typeof snapshot.limit !== 'number') {
    return false;
  }

  return snapshot.used + amount > snapshot.limit;
}

export async function checkUsage(userId: string, feature: UsageFeature, amount = 1, scope: UsageScope = 'day'): Promise<UsageCheckResult> {
  const plan = await getEffectivePlanForUser(userId);
  const usage = await getUsage(userId, feature, scope);
  const remaining = typeof usage.limit === 'number' ? Math.max(usage.limit - usage.used - amount, 0) : null;

  let allowed = true;
  let reason = 'Usage available.';

  if (feature === 'live_tutor') {
    const wallet = await prisma.liveTutorWallet.findUnique({ where: { userId } });
    const liveTutorMinutes = wallet?.minutesBalance ?? 0;
    if (liveTutorMinutes < amount) {
      allowed = false;
      reason = 'Live tutor minutes are exhausted.';
    }
  } else if (typeof usage.limit === 'number' && usage.used + amount > usage.limit) {
    allowed = false;
    reason = 'Plan usage limit reached.';
  }

  return {
    allowed,
    reason: normalizeReason(reason),
    remainingUsage: remaining,
    resetTime: usage.resetAt?.toISOString() ?? null,
    upgradeAvailable: plan.name !== 'PRO',
    modelUsed: plan.chatModel,
    usage,
  };
}

export async function logUsage(input: UsageLogInput): Promise<UsageCheckResult> {
  const { userId, feature, amount = 1, scope = 'day', provider, modelUsed, requestId, success, metadata } = input;
  const billingDecision = await reserveUsage({
    userId,
    feature,
    amount,
    provider,
    modelUsed,
    requestId,
    metadata,
    scope,
  });

  return {
    allowed: billingDecision.allowed,
    reason: billingDecision.reason,
    remainingUsage: billingDecision.remainingUsage,
    resetTime: billingDecision.resetTime,
    upgradeAvailable: billingDecision.upgradeAvailable,
    modelUsed: billingDecision.modelUsed,
    usage: billingDecision.usage,
  };
}

export async function recordUsage(
  userId: string,
  feature: UsageFeature,
  amount = 1,
  options?: {
    provider?: string;
    modelUsed?: string | null;
    requestId?: string;
    success?: boolean;
    metadata?: Record<string, unknown>;
    scope?: UsageScope;
  }
): Promise<UsageCheckResult> {
  return logUsage({
    userId,
    feature,
    amount,
    scope: options?.scope ?? 'day',
    provider: options?.provider,
    modelUsed: options?.modelUsed,
    requestId: options?.requestId,
    success: options?.success,
    metadata: options?.metadata,
  });
}
