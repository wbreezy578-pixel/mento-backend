import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma';
import { ensureDefaultPlans, getPlanForUser, getEffectivePlanForUser, getEffectiveLimit, getFreePlan, isSubscriptionActive, type PlanRecord } from './planService';
import { calculateProviderCost, calculateUserCharge, calculateProfit } from './economicsService';
import type { UsageScope, UsageFeature, UsageSnapshot } from './usageService';
import { incrementMonitoringFailure, observeMonitoringLatency } from '../lib/monitoring';
import { isDevLiveTutorFreeEnabled } from '../lib/env';
import logger from '../lib/logger';
import '../lib/metrics';

// LiveTutorWallet.minutesBalance is stored in minutes; live_tutor amounts are always passed in seconds.
const SECONDS_PER_MINUTE = 60;

export interface BillingDecision {
  allowed: boolean;
  reason: string;
  remainingUsage: number | null;
  resetTime: string | null;
  upgradeAvailable: boolean;
  modelUsed?: string | null;
  usage: UsageSnapshot;
  ledgerId?: string | null;
  idempotent?: boolean;
  providerCostUSD?: number;
  userChargeUSD?: number;
  profitUSD?: number;
}

export interface BillingSummary {
  currentPlan: string;
  messagesRemaining: number | null;
  imagesRemaining: number | null;
  liveTutorSeconds: number;
  resetTime: string | null;
  upgradeAvailable: boolean;
  fairUseEnabled: boolean;
  liveTutorEnabled: boolean;
  imageDailyLimit: number | null;
  messageLimit: number | null;
  imageLimit: number | null;
  fairUseChatLimit: number | null;
  fairUseImageLimit: number | null;
  liveTutorBalance: number;
  subscriptionStatus: string;
  todaysImageUsage: number;
}

export interface BillingReservationInput {
  userId: string;
  feature: 'chat' | 'image' | 'live_tutor';
  amount?: number;
  provider?: string;
  modelUsed?: string | null;
  requestId?: string;
  success?: boolean;
  pending?: boolean;
  metadata?: Record<string, unknown>;
  scope?: UsageScope;
  planOverride?: PlanRecord | null;
  tokensInput?: number;
  tokensOutput?: number;
  secondsUsed?: number;
}

function normalizeReason(value: string | null | undefined): string {
  return value ?? 'Usage limit reached.';
}

function validateBillingReservationInput(input: BillingReservationInput) {
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : null;
  if (!userId) {
    throw new Error('Invalid userId');
  }

  const feature = input.feature;
  if (feature !== 'chat' && feature !== 'image' && feature !== 'live_tutor') {
    throw new Error('Unsupported billing feature');
  }

  const amount = Math.max(1, Math.floor(input.amount ?? 1));
  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : getDefaultProvider(feature);
  const requestId = typeof input.requestId === 'string' && input.requestId.trim() ? input.requestId.trim().slice(0, 200) : undefined;
  const scope = input.scope ?? 'day';
  if (scope !== 'day' && scope !== 'month' && scope !== 'rolling') {
    throw new Error('Unsupported billing scope');
  }

  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {};
  const pending = Boolean(input.pending);
  const tokensInput = Math.max(0, Math.floor(input.tokensInput ?? 0));
  const tokensOutput = Math.max(0, Math.floor(input.tokensOutput ?? 0));
  const secondsUsed = Math.max(0, Math.floor(input.secondsUsed ?? 0));

  return {
    userId,
    feature,
    amount,
    provider,
    modelUsed: input.modelUsed ?? null,
    requestId,
    success: input.success,
    metadata,
    scope,
    pending,
    planOverride: input.planOverride ?? null,
    tokensInput,
    tokensOutput,
    secondsUsed,
  };
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

function toUsageFeature(feature: 'chat' | 'image' | 'live_tutor'): string {
  return feature === 'live_tutor' ? 'live_tutor' : feature;
}

function getDefaultProvider(feature: 'chat' | 'image' | 'live_tutor'): string {
  if (feature === 'image') return 'ImageGen';
  if (feature === 'live_tutor') return 'Simli';
  return 'Gemini';
}

function buildUsageSnapshot(
  feature: 'chat' | 'image' | 'live_tutor',
  scope: UsageScope,
  used: number,
  limit: number | null,
  resetAtOverride?: Date,
): UsageSnapshot {
  const resetAt = resetAtOverride ?? getResetTime(scope);
  return {
    feature,
    scope,
    used,
    limit,
    remaining: typeof limit === 'number' ? Math.max(limit - used, 0) : null,
    resetAt,
  };
}

function buildDecision(
  allowed: boolean,
  reason: string,
  usage: UsageSnapshot,
  plan: PlanRecord,
  remainingUsage: number | null,
  ledgerId?: string | null,
  idempotent = false,
  providerCostUSD?: number,
  userChargeUSD?: number,
  profitUSD?: number,
  modelUsed?: string | null,
): BillingDecision {
  return {
    allowed,
    reason: normalizeReason(reason),
    remainingUsage,
    resetTime: usage.resetAt?.toISOString() ?? null,
    upgradeAvailable: plan.name !== 'PRO',
    modelUsed: modelUsed ?? plan.chatModel,
    usage,
    ledgerId,
    idempotent,
    providerCostUSD,
    userChargeUSD,
    profitUSD,
  };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePlanModelName(model: string | null | undefined): string {
  return typeof model === 'string' && model.trim() ? model.trim().toLowerCase() : '';
}


function resolvePlanModel(plan: PlanRecord, feature: 'chat' | 'image' | 'live_tutor', requestedModel?: string | null): string {
  const fallbackModel = feature === 'image' ? (plan.features.imageModel as string | undefined) ?? plan.chatModel : plan.chatModel;
  const requested = typeof requestedModel === 'string' && requestedModel.trim() ? requestedModel.trim() : null;
  const allowedModels = Array.isArray(plan.features.availableModels)
    ? plan.features.availableModels.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];

  if (requested) {
    const requestedNormalized = normalizePlanModelName(requested);
    const isAllowed = allowedModels.length === 0 || allowedModels.some((candidate) => normalizePlanModelName(candidate) === requestedNormalized);
    if (isAllowed) {
      return requested;
    }
  }

  return fallbackModel;
}

function getUsageWindow(plan: PlanRecord, feature: 'chat' | 'image' | 'live_tutor', modelUsed?: string | null, scope: UsageScope = 'day') {
  const now = new Date();

  if (feature === 'image') {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return {
      windowStart: startOfDay,
      resetAt: nextDay,
      usageLimit: getEffectiveLimit(plan, 'image', { modelUsed }),
    };
  }

  if (feature === 'live_tutor') {
    return {
      windowStart: getWindowStart(scope),
      resetAt: getResetTime(scope),
      usageLimit: null,
    };
  }

  const resolvedModel = resolvePlanModel(plan, 'chat', modelUsed);
  const normalizedModel = normalizePlanModelName(resolvedModel);
  const proDailyLimit = toNumber(plan.features.proChatDailyLimit);
  if (normalizedModel.includes('pro') && typeof proDailyLimit === 'number') {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return {
      windowStart: startOfDay,
      resetAt: nextDay,
      usageLimit: proDailyLimit,
    };
  }

  const windowMinutes = toNumber(plan.features.chatWindowMinutes) ?? 180;
  const windowLimit = getEffectiveLimit(plan, 'chat', { modelUsed: resolvedModel });
  return {
    windowStart: new Date(now.getTime() - windowMinutes * 60 * 1000),
    resetAt: new Date(now.getTime() + windowMinutes * 60 * 1000),
    usageLimit: windowLimit,
  };
}

async function getBillingDecision(input: BillingReservationInput): Promise<BillingDecision> {
  const validatedInput = validateBillingReservationInput(input);
  const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
  await ensureDefaultPlans();

  if (validatedInput.feature === 'live_tutor') {
    const liveTutorWallet = await prisma.liveTutorWallet.findUnique({ where: { userId: validatedInput.userId } });
    const availableSeconds = (liveTutorWallet?.minutesBalance ?? 0) * SECONDS_PER_MINUTE;
    
    // Development-only bypass: allow Live Tutor with zero balance if DEV_LIVE_TUTOR_FREE=true
    const devBypassEnabled = isDevLiveTutorFreeEnabled();
    const allowed = devBypassEnabled || availableSeconds >= validatedInput.amount;
    const reason = allowed 
      ? (devBypassEnabled && availableSeconds < validatedInput.amount ? '[DEV] Live tutor free mode enabled.' : 'Live tutor seconds available.')
      : 'Live tutor balance is exhausted.';
    
    if (devBypassEnabled && availableSeconds < validatedInput.amount) {
      logger.info('Live Tutor dev bypass applied', {
        userId: validatedInput.userId,
        requestedSeconds: validatedInput.amount,
        availableSeconds,
        requestId: validatedInput.requestId,
      });
    }
    
    const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, 0, null);

    return buildDecision(
      allowed,
      reason,
      usage,
      plan,
      Math.max(availableSeconds - validatedInput.amount, 0),
      null,
      false,
      0,
      0,
      0,
      validatedInput.modelUsed ?? plan.chatModel,
    );
  }

  const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
  const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
  const windowStart = usageWindow.windowStart;
  const used = await prisma.usageLog.count({
    where: {
      userId: validatedInput.userId,
      feature: toUsageFeature(validatedInput.feature),
      success: true,
      createdAt: { gte: windowStart },
    },
  });

  const usageLimit = usageWindow.usageLimit;
  const remainingUsage = typeof usageLimit === 'number'
    ? Math.max(usageLimit - used - validatedInput.amount, 0)
    : null;
  const allowed = typeof usageLimit === 'number'
    ? used + validatedInput.amount <= usageLimit
    : true;
  const reason = allowed ? 'Usage available.' : 'Plan usage limit reached.';
  const usage = buildUsageSnapshot(
    validatedInput.feature,
    validatedInput.scope,
    allowed ? used + validatedInput.amount : used,
    usageLimit,
    usageWindow.resetAt,
  );

  return buildDecision(
    allowed,
    reason,
    usage,
    plan,
    remainingUsage,
    null,
    false,
    0,
    0,
    0,
    validatedInput.modelUsed ?? plan.chatModel,
  );
}

const MAX_TRANSACTION_RETRIES = 6;
const TRANSACTION_RETRY_BASE_DELAY_MS = 150;
const TRANSACTION_RETRY_MAX_DELAY_MS = 900;
const TRANSACTION_CONCURRENCY_LIMIT = 6;

function createSemaphore(maxConcurrency: number) {
  let current = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (current < maxConcurrency) {
      current += 1;
      return release;
    }

    return new Promise<() => void>((resolve) => {
      queue.push(() => {
        current += 1;
        resolve(release);
      });
    });
  }

  function release() {
    current = Math.max(0, current - 1);
    const next = queue.shift();
    if (next) {
      next();
    }
  }

  return { acquire };
}

const transactionSemaphore = createSemaphore(TRANSACTION_CONCURRENCY_LIMIT);
const userTransactionQueues = new Map<string, Array<(release: () => void) => void>>();
const activeUserTransactions = new Set<string>();

async function acquireUserTransactionLock(userId: string): Promise<() => void> {
  if (!activeUserTransactions.has(userId)) {
    activeUserTransactions.add(userId);
    return () => releaseUserTransactionLock(userId);
  }

  return new Promise((resolve) => {
    const queue = userTransactionQueues.get(userId) ?? [];
    queue.push(resolve);
    userTransactionQueues.set(userId, queue);
  });
}

function releaseUserTransactionLock(userId: string) {
  const queue = userTransactionQueues.get(userId) ?? [];
  if (queue.length > 0) {
    const next = queue.shift();
    if (next) {
      next(() => releaseUserTransactionLock(userId));
    }
    if (queue.length === 0) {
      userTransactionQueues.delete(userId);
    }
    return;
  }

  activeUserTransactions.delete(userId);
}

async function runTransactionWithRetries<T>(userId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const releaseTransaction = await transactionSemaphore.acquire();
  const releaseUserLock = await acquireUserTransactionLock(userId);

  try {
    let attempt = 0;
    while (true) {
      try {
        const result = await prisma.$transaction(callback, {
          maxWait: 60000,
          timeout: 60000,
        });
        observeMonitoringLatency('billing', Date.now() - startedAt, { operation: 'transaction' });
        return result;
      } catch (error) {
        attempt += 1;
        if (attempt >= MAX_TRANSACTION_RETRIES || !isTransientTransactionError(error)) {
          observeMonitoringLatency('billing', Date.now() - startedAt, { operation: 'transaction', status: 'error' });
          incrementMonitoringFailure('payment', { source: 'billing', reason: 'transaction' });
          throw error;
        }

        const delay = Math.min(
          TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          TRANSACTION_RETRY_MAX_DELAY_MS,
        );
        const jitter = Math.floor(Math.random() * 100);
        const wait = delay + jitter;
        console.warn('[billingService] transient transaction error, retrying', {
          attempt,
          maxAttempts: MAX_TRANSACTION_RETRIES,
          error: error instanceof Error ? error.message : String(error),
          wait,
        });
        await sleep(wait);
      }
    }
  } finally {
    releaseUserLock();
    releaseTransaction();
  }
}

async function resolveWalletAndPlanInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  fallbackPlan: PlanRecord,
): Promise<{ wallet: { id: string; userId: string; planId: string; planName: string; subscriptionStatus: string } | null; plan: PlanRecord }> {
  const existingWallet = await tx.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });

  const wallet = existingWallet ?? await createOrFindUserWallet(tx, userId, fallbackPlan);

  const planRecord = wallet.plan ? {
    id: wallet.plan.id,
    name: wallet.plan.name,
    price: wallet.plan.price,
    messageLimit: wallet.plan.messageLimit,
    imageLimit: wallet.plan.imageLimit,
    chatModel: wallet.plan.chatModel,
    fairUseEnabled: wallet.plan.fairUseEnabled,
    imageDailyLimit: wallet.plan.imageDailyLimit,
    priority: wallet.plan.priority,
    liveTutorEnabled: wallet.plan.liveTutorEnabled,
    features: wallet.plan.features as Record<string, unknown>,
  } as PlanRecord : fallbackPlan;

  const effectivePlan = isSubscriptionActive(wallet.subscriptionStatus as string, wallet.subscriptionExpiresAt)
    ? planRecord
    : await getFreePlan();

  return {
    wallet: {
      id: wallet.id,
      userId: wallet.userId,
      planId: wallet.planId,
      planName: wallet.plan.name,
      subscriptionStatus: wallet.subscriptionStatus,
    },
    plan: effectivePlan,
  };
}

async function createOrFindUserWallet(
  tx: Prisma.TransactionClient,
  userId: string,
  fallbackPlan: PlanRecord,
) {
  try {
    return await tx.userWallet.create({
      data: {
        user: { connect: { id: userId } },
        plan: { connect: { id: fallbackPlan.id } },
        subscriptionStatus: 'active',
      },
      include: { plan: true },
    });
  } catch (error) {
    if (
      error instanceof PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await tx.userWallet.findUnique({
        where: { userId },
        include: { plan: true },
      });
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}

async function lockWalletRow(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "UserWallet" WHERE "userId" = ${userId} FOR UPDATE`;
}

async function lockLiveTutorWalletRow(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "LiveTutorWallet" WHERE "userId" = ${userId} FOR UPDATE`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTransactionError(error: unknown): boolean {
  if (error instanceof PrismaClientKnownRequestError) {
    return error.code === 'P2028';
  }
  return false;
}

async function createUsageLedgerEntry(
  tx: Prisma.TransactionClient,
  input: BillingReservationInput,
  plan: PlanRecord,
  allowed: boolean,
  reason: string,
  usage: UsageSnapshot,
  providerCostUSD: number,
  userChargeUSD: number,
  profitUSD: number,
  metadata?: Record<string, unknown>,
): Promise<{ id: string; success: boolean; providerCostUSD: number; userChargeUSD: number; profitUSD: number }> {
  const provider = input.provider ?? getDefaultProvider(input.feature);
  const successValue = typeof input.success === 'boolean' ? input.success : (input.pending ? false : allowed);
  const secondsUsed = typeof input.secondsUsed === 'number' ? input.secondsUsed : (input.feature === 'live_tutor' ? (input.amount ?? 1) * 60 : 0);

  try {
    console.log('[billingService] createUsageLedgerEntry start', { userId: input.userId, feature: input.feature, requestId: input.requestId, provider, allowed, successValue });
    const record = await tx.usageLog.create({
      data: {
        userId: input.userId,
        feature: toUsageFeature(input.feature),
        provider,
        requestId: input.requestId ?? null,
        modelUsed: input.modelUsed ?? plan.chatModel,
        planName: plan.name,
        success: successValue,
        secondsUsed,
        tokensInput: input.tokensInput,
        tokensOutput: input.tokensOutput,
        providerCostUSD,
        userChargeUSD,
        profitUSD,
        metadata: (metadata ?? {}) as InputJsonValue,
      },
      select: {
        id: true,
        success: true,
        providerCostUSD: true,
        userChargeUSD: true,
        profitUSD: true,
      },
    });
    console.log('[billingService] createUsageLedgerEntry success', { userId: input.userId, requestId: input.requestId, id: record.id });
    return record;
  } catch (error) {
    console.error('[billingService] createUsageLedgerEntry failed', { userId: input.userId, requestId: input.requestId, provider, allowed, error });
    if (
      input.requestId &&
      error instanceof PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await tx.usageLog.findUnique({
        where: {
          provider_requestId: {
            provider,
            requestId: input.requestId,
          },
        },
        select: {
          id: true,
          success: true,
          providerCostUSD: true,
          userChargeUSD: true,
          profitUSD: true,
        },
      });

      if (existing) {
        return existing;
      }
    }

    throw error;
  }
}

export async function reserveUsage(input: BillingReservationInput): Promise<BillingDecision> {
  const validatedInput = validateBillingReservationInput(input);
  const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
  const resolvedModel = validatedInput.modelUsed ?? plan.chatModel;

  await ensureDefaultPlans();

  const providerCostUSD = await calculateProviderCost({
    feature: validatedInput.feature,
    provider: validatedInput.provider,
    tokensInput: validatedInput.tokensInput,
    tokensOutput: validatedInput.tokensOutput,
    secondsUsed: validatedInput.secondsUsed,
  });
  const userChargeUSD = await calculateUserCharge({
    feature: validatedInput.feature,
    provider: validatedInput.provider,
    tokensInput: validatedInput.tokensInput,
    tokensOutput: validatedInput.tokensOutput,
    secondsUsed: validatedInput.secondsUsed,
  });
  const profitUSD = await calculateProfit({
    feature: validatedInput.feature,
    provider: validatedInput.provider,
    tokensInput: validatedInput.tokensInput,
    tokensOutput: validatedInput.tokensOutput,
    secondsUsed: validatedInput.secondsUsed,
  });

  try {
    return await runTransactionWithRetries(validatedInput.userId, async (tx) => {
      const existing = validatedInput.requestId
        ? await tx.usageLog.findUnique({
            where: {
              provider_requestId: {
                provider: validatedInput.provider,
                requestId: validatedInput.requestId,
              },
            },
          })
        : null;

      const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
      const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
      const windowStart = usageWindow.windowStart;
      const resetAt = usageWindow.resetAt;

      if (existing) {
        const used = await tx.usageLog.count({
          where: {
            userId: validatedInput.userId,
            feature: toUsageFeature(validatedInput.feature),
            success: true,
            createdAt: { gte: windowStart },
          },
        });

        const effectivePlan = plan;
        const usageLimit = validatedInput.feature === 'live_tutor'
          ? null
          : getEffectiveLimit(effectivePlan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
        const remainingUsage = typeof usageLimit === 'number'
          ? Math.max(usageLimit - used - validatedInput.amount, 0)
          : null;
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);

        return buildDecision(
          existing.success ?? false,
          existing.success ? 'Idempotent reservation already recorded.' : 'Idempotent reservation already rejected.',
          usage,
          effectivePlan,
          remainingUsage,
          existing.id,
          true,
          existing.providerCostUSD,
          existing.userChargeUSD,
          existing.profitUSD,
          resolvedModel,
        );
      }

      const { wallet, plan: walletPlan } = await resolveWalletAndPlanInTransaction(tx, validatedInput.userId, plan);
      if (!wallet) {
        throw new Error('Failed to initialize billing wallet');
      }

      const effectivePlan = walletPlan;
      const usageLimit = validatedInput.feature === 'live_tutor'
        ? null
        : getEffectiveLimit(effectivePlan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });

      if (validatedInput.feature === 'live_tutor') {
        await lockLiveTutorWalletRow(tx, validatedInput.userId);
        const liveTutorWallet = await tx.liveTutorWallet.upsert({
          where: { userId: validatedInput.userId },
          update: {},
          create: {
            user: { connect: { id: validatedInput.userId } },
            minutesBalance: 0,
          },
        });

        const availableSeconds = liveTutorWallet.minutesBalance * SECONDS_PER_MINUTE;
        const devBypassEnabled = isDevLiveTutorFreeEnabled();
        const allowed = devBypassEnabled || availableSeconds >= validatedInput.amount;
        const pendingReservation = validatedInput.pending === true;
        const effectiveAllowed = pendingReservation ? allowed : (validatedInput.success === false ? false : allowed);
        const reason = pendingReservation
          ? 'Live tutor reservation pending.'
          : effectiveAllowed
            ? (devBypassEnabled ? '[DEV] Live tutor free mode enabled.' : 'Live tutor minutes available.')
            : validatedInput.success === false
              ? 'Usage rollback requested.'
              : (devBypassEnabled ? '[DEV] Live tutor free mode enabled.' : 'Live tutor minutes are exhausted.');
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, 0, null);
        const metadata = {
          ...validatedInput.metadata,
          amount: validatedInput.amount,
          scope: validatedInput.scope,
          reason,
          requestedBy: validatedInput.userId,
          requestedAt: new Date().toISOString(),
        };

        if (devBypassEnabled && availableSeconds < validatedInput.amount) {
          logger.info('Live Tutor dev bypass applied in reserveUsage', {
            userId: validatedInput.userId,
            requestedSeconds: validatedInput.amount,
            availableSeconds,
            requestId: validatedInput.requestId,
          });
        }

        if (!effectiveAllowed) {
          const deniedRecord = await createUsageLedgerEntry(
            tx,
            validatedInput,
            effectivePlan,
            false,
            reason,
            usage,
            0,
            0,
            0,
            metadata,
          );

          return buildDecision(
            false,
            reason,
            usage,
            effectivePlan,
            0,
            deniedRecord.id,
            false,
            0,
            0,
            0,
            resolvedModel,
          );
        }

        const successRecord = await createUsageLedgerEntry(
          tx,
          { ...validatedInput, pending: pendingReservation },
          effectivePlan,
          pendingReservation ? false : true,
          reason,
          usage,
          providerCostUSD,
          userChargeUSD,
          profitUSD,
          metadata,
        );

        if (!pendingReservation) {
          await tx.liveTutorWallet.update({
            where: { userId: validatedInput.userId },
            data: { minutesBalance: { decrement: Math.ceil(validatedInput.amount / SECONDS_PER_MINUTE) } },
          });
        }

        return buildDecision(
          true,
          reason,
          usage,
          effectivePlan,
          pendingReservation ? availableSeconds : Math.max(availableSeconds - validatedInput.amount, 0),
          successRecord.id,
          false,
          successRecord.providerCostUSD,
          successRecord.userChargeUSD,
          successRecord.profitUSD,
          resolvedModel,
        );
      }

      await lockWalletRow(tx, validatedInput.userId);
      const used = await tx.usageLog.count({
        where: {
          userId: validatedInput.userId,
          feature: toUsageFeature(validatedInput.feature),
          success: true,
          createdAt: { gte: windowStart },
        },
      });

      const pendingReservation = validatedInput.pending === true;
      const remainingUsage = typeof usageLimit === 'number'
        ? Math.max(usageLimit - used - (pendingReservation ? 0 : validatedInput.amount), 0)
        : null;
      const allowed = typeof usageLimit === 'number'
        ? used + validatedInput.amount <= usageLimit
        : true;
      const effectiveAllowed = pendingReservation ? allowed : (validatedInput.success === false ? false : allowed);
      const reason = pendingReservation
        ? 'Usage reservation pending.'
        : effectiveAllowed
          ? 'Usage available.'
          : validatedInput.success === false
            ? 'Usage rollback requested.'
            : 'Plan usage limit reached.';
      const usage = buildUsageSnapshot(
        validatedInput.feature,
        validatedInput.scope,
        effectiveAllowed ? used + validatedInput.amount : used,
        usageLimit,
        usageWindow.resetAt,
      );
      const metadata = {
        ...validatedInput.metadata,
        amount: validatedInput.amount,
        scope: validatedInput.scope,
        windowStart: windowStart.toISOString(),
        resetAt: resetAt.toISOString(),
        reason,
      };

      if (!effectiveAllowed) {
        const deniedRecord = await createUsageLedgerEntry(
          tx,
          validatedInput,
          effectivePlan,
          false,
          reason,
          usage,
          0,
          0,
          0,
          metadata,
        );

        return buildDecision(
          false,
          reason,
          usage,
          effectivePlan,
          remainingUsage,
          deniedRecord.id,
          false,
          0,
          0,
          0,
          resolvedModel,
        );
      }

      const successRecord = await createUsageLedgerEntry(
        tx,
        { ...validatedInput, pending: pendingReservation },
        effectivePlan,
        pendingReservation ? false : true,
        reason,
        usage,
        providerCostUSD,
        userChargeUSD,
        profitUSD,
        metadata,
      );

      return buildDecision(
        true,
        reason,
        usage,
        effectivePlan,
        remainingUsage,
        successRecord.id,
        false,
        successRecord.providerCostUSD,
        successRecord.userChargeUSD,
        successRecord.profitUSD,
        resolvedModel,
      );
    });
  } catch (error) {
    console.error('[billingService] reserveUsage transaction failed', {
      userId: input.userId,
      requestId: input.requestId,
      error,
    });
    throw error;
  }
}

export async function canUseChat(userId: string, amount = 1): Promise<BillingDecision> {
  return getBillingDecision({ userId, feature: 'chat', amount });
}

export async function canGenerateImage(userId: string, amount = 1): Promise<BillingDecision> {
  return getBillingDecision({ userId, feature: 'image', amount });
}

export async function canUseLiveTutor(userId: string, amount = 1): Promise<BillingDecision> {
  return getBillingDecision({ userId, feature: 'live_tutor', amount });
}

export async function canUseFeature(userId: string, feature: 'chat' | 'image' | 'live_tutor', amount = 1): Promise<BillingDecision> {
  return getBillingDecision({ userId, feature, amount });
}

export async function consumeLiveTutorMinutes(userId: string, amount = 1): Promise<BillingDecision> {
  return reserveUsage({ userId, feature: 'live_tutor', amount });
}

export async function finalizeUsage(input: BillingReservationInput): Promise<BillingDecision> {
  const validatedInput = validateBillingReservationInput(input);
  if (!validatedInput.requestId) {
    throw new Error('requestId is required for finalizeUsage');
  }

  const provider = validatedInput.provider;

  try {
    return await runTransactionWithRetries(validatedInput.userId, async (tx) => {
      const existing = await tx.usageLog.findUnique({
        where: {
          provider_requestId: {
            provider,
            requestId: validatedInput.requestId!,
          },
        },
      });

      if (!existing) {
        return reserveUsage({ ...validatedInput, success: true });
      }

      if (existing.success === true) {
        const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
        const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
        const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
        const windowStart = usageWindow.windowStart;
        const used = await tx.usageLog.count({
          where: {
            userId: validatedInput.userId,
            feature: toUsageFeature(validatedInput.feature),
            success: true,
            createdAt: { gte: windowStart },
          },
        });
        const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
        const remainingUsage = typeof usageLimit === 'number'
          ? Math.max(usageLimit - used - validatedInput.amount, 0)
          : null;
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);

        return buildDecision(
          true,
          'Reservation already finalized.',
          usage,
          plan,
          remainingUsage,
          existing.id,
          true,
          existing.providerCostUSD,
          existing.userChargeUSD,
          existing.profitUSD,
          validatedInput.modelUsed ?? plan.chatModel,
        );
      }

      if (validatedInput.feature === 'live_tutor') {
        await lockLiveTutorWalletRow(tx, validatedInput.userId);
        const liveTutorWallet = await tx.liveTutorWallet.upsert({
          where: { userId: validatedInput.userId },
          update: {},
          create: {
            user: { connect: { id: validatedInput.userId } },
            minutesBalance: 0,
          },
        });
        await tx.liveTutorWallet.update({
          where: { userId: validatedInput.userId },
          data: { minutesBalance: { decrement: Math.ceil(validatedInput.amount / SECONDS_PER_MINUTE) } },
        });
        await tx.usageLog.update({
          where: { id: existing.id },
          data: { success: true },
        });
        const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
        const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
        const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
        const windowStart = usageWindow.windowStart;
        const used = await tx.usageLog.count({
          where: {
            userId: validatedInput.userId,
            feature: toUsageFeature(validatedInput.feature),
            success: true,
            createdAt: { gte: windowStart },
          },
        });
        const usageLimit = null;
        const remainingUsage = null;
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);
        return buildDecision(
          true,
          'Reservation finalized.',
          usage,
          plan,
          remainingUsage,
          existing.id,
          true,
          existing.providerCostUSD,
          existing.userChargeUSD,
          existing.profitUSD,
          validatedInput.modelUsed ?? plan.chatModel,
        );
      }

      await tx.usageLog.update({
        where: { id: existing.id },
        data: { success: true },
      });

      const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
      const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
      const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
      const windowStart = usageWindow.windowStart;
      const used = await tx.usageLog.count({
        where: {
          userId: validatedInput.userId,
          feature: toUsageFeature(validatedInput.feature),
          success: true,
          createdAt: { gte: windowStart },
        },
      });
      const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
      const remainingUsage = typeof usageLimit === 'number'
        ? Math.max(usageLimit - used - validatedInput.amount, 0)
        : null;
      const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);

      return buildDecision(
        true,
        'Reservation finalized.',
        usage,
        plan,
        remainingUsage,
        existing.id,
        true,
        existing.providerCostUSD,
        existing.userChargeUSD,
        existing.profitUSD,
        validatedInput.modelUsed ?? plan.chatModel,
      );
    });
  } catch (error) {
    console.error('[billingService] finalizeUsage transaction failed', {
      userId: validatedInput.userId,
      requestId: validatedInput.requestId,
      error,
    });
    throw error;
  }
}

export async function rollbackUsage(input: BillingReservationInput): Promise<BillingDecision> {
  const validatedInput = validateBillingReservationInput(input);
  if (!validatedInput.requestId) {
    throw new Error('requestId is required for rollbackUsage');
  }

  const provider = validatedInput.provider;

  try {
    return await runTransactionWithRetries(validatedInput.userId, async (tx) => {
      const existing = await tx.usageLog.findUnique({
        where: {
          provider_requestId: {
            provider,
            requestId: validatedInput.requestId!,
          },
        },
      });

      if (!existing) {
        return reserveUsage({ ...validatedInput, success: false });
      }

      if (existing.success === true) {
        const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
        const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
        const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
        const windowStart = usageWindow.windowStart;
        const used = await tx.usageLog.count({
          where: {
            userId: validatedInput.userId,
            feature: toUsageFeature(validatedInput.feature),
            success: true,
            createdAt: { gte: windowStart },
          },
        });
        const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
        const remainingUsage = typeof usageLimit === 'number'
          ? Math.max(usageLimit - used - validatedInput.amount, 0)
          : null;
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);

        return buildDecision(
          true,
          'Reservation already finalized.',
          usage,
          plan,
          remainingUsage,
          existing.id,
          true,
          existing.providerCostUSD,
          existing.userChargeUSD,
          existing.profitUSD,
          validatedInput.modelUsed ?? plan.chatModel,
        );
      }

      if (existing.success === false) {
        const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
        const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
        const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
        const windowStart = usageWindow.windowStart;
        const used = await tx.usageLog.count({
          where: {
            userId: validatedInput.userId,
            feature: toUsageFeature(validatedInput.feature),
            success: true,
            createdAt: { gte: windowStart },
          },
        });
        const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
        const remainingUsage = typeof usageLimit === 'number'
          ? Math.max(usageLimit - used - validatedInput.amount, 0)
          : null;
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);

        return buildDecision(
          false,
          'Reservation already rolled back.',
          usage,
          plan,
          remainingUsage,
          existing.id,
          true,
          existing.providerCostUSD,
          existing.userChargeUSD,
          existing.profitUSD,
          validatedInput.modelUsed ?? plan.chatModel,
        );
      }

      if (validatedInput.feature === 'live_tutor') {
        await lockLiveTutorWalletRow(tx, validatedInput.userId);
        await tx.liveTutorWallet.upsert({
          where: { userId: validatedInput.userId },
          update: {},
          create: {
            user: { connect: { id: validatedInput.userId } },
            minutesBalance: 0,
          },
        });
      }

      await tx.usageLog.update({
        where: { id: existing.id },
        data: { success: false },
      });

      const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
      const resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
      const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
      const windowStart = usageWindow.windowStart;
      const used = await tx.usageLog.count({
        where: {
          userId: validatedInput.userId,
          feature: toUsageFeature(validatedInput.feature),
          success: true,
          createdAt: { gte: windowStart },
        },
      });
      const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
      const remainingUsage = typeof usageLimit === 'number'
        ? Math.max(usageLimit - used - validatedInput.amount, 0)
        : null;
      const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);

      return buildDecision(
        false,
        'Reservation rolled back.',
        usage,
        plan,
        remainingUsage,
        existing.id,
        true,
        existing.providerCostUSD,
        existing.userChargeUSD,
        existing.profitUSD,
        validatedInput.modelUsed ?? plan.chatModel,
      );
    });
  } catch (error) {
    console.error('[billingService] rollbackUsage transaction failed', {
      userId: validatedInput.userId,
      requestId: validatedInput.requestId,
      error,
    });
    throw error;
  }
}

