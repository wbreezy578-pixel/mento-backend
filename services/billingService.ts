import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma';
import { ensureDefaultPlans, getPlanForUser, getEffectivePlanForUser, getEffectiveLimit, getFreePlan, isSubscriptionActive, type PlanRecord } from './planService';
import { calculateProviderCost, calculateUserCharge, calculateProfit } from './economicsService';
import type { UsageScope, UsageFeature, UsageSnapshot } from './usageService';
import { incrementMonitoringFailure, observeMonitoringLatency } from '../lib/monitoring';
import logger from '../lib/logger';
import '../lib/metrics';
import { canStartLiveTutorSession } from './liveTutorBillingPolicy';
import { evaluateCompletedAllowance, getProductPolicy, getUtcDayWindow, getFreeMonthlyWindow, resolvePolicyModel } from './productPolicy';
import { allocateLiveTutorConsumption } from './entitlementService';
import { calculateGeminiProviderCostUSD, GEMINI_PRICING_SOURCE, GEMINI_PRICING_VERSION, isSupportedNormalChatModel } from './geminiPricing';
import {
  assertAndLockGeminiDailyBudget,
  assertAndLockGeminiAdditionalExposure,
  getGeminiDailyBudgetPolicy,
  GeminiDailyBudgetExceededError,
  GeminiDailyBudgetUnavailableError,
  isNormalChatGeminiBudgetSubject,
} from './geminiDailyBudget';

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
  tokensCached?: number;
  tokensThinking?: number;
  tokensTotal?: number;
  usageSource?: 'PROVIDER_REPORTED' | 'ESTIMATED' | 'UNKNOWN';
  secondsUsed?: number;
  providerCostUSDOverride?: number;
  providerExposureUSD?: number;
  providerAttemptCount?: number;
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
  const tokensCached = Math.max(0, Math.floor(input.tokensCached ?? 0));
  const tokensThinking = Math.max(0, Math.floor(input.tokensThinking ?? 0));
  const tokensTotal = Math.max(0, Math.floor(input.tokensTotal ?? (tokensInput + tokensOutput + tokensThinking)));
  const usageSource: NonNullable<BillingReservationInput['usageSource']> = input.usageSource === 'PROVIDER_REPORTED' || input.usageSource === 'ESTIMATED'
    ? input.usageSource
    : 'UNKNOWN';
  const secondsUsed = Math.max(0, Math.floor(input.secondsUsed ?? 0));
  const providerCostUSDOverride = typeof input.providerCostUSDOverride === 'number' && Number.isFinite(input.providerCostUSDOverride)
    ? Math.max(0, input.providerCostUSDOverride)
    : undefined;
  const providerExposureUSD = typeof input.providerExposureUSD === 'number' && Number.isFinite(input.providerExposureUSD)
    ? Math.max(0, input.providerExposureUSD)
    : undefined;
  const providerAttemptCount = Math.max(0, Math.floor(input.providerAttemptCount ?? 0));

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
    tokensCached,
    tokensThinking,
    tokensTotal,
    usageSource,
    secondsUsed,
    providerCostUSDOverride,
    providerExposureUSD,
    providerAttemptCount,
  };
}

function getGenerationOutcome(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const outcome = (metadata as Prisma.JsonObject).generationOutcome;
  return typeof outcome === 'string' ? outcome : null;
}

function isNonCompletedGenerationOutcome(metadata: Prisma.JsonValue | null): boolean {
  const outcome = getGenerationOutcome(metadata);
  return outcome === 'cancelled' || outcome === 'persistence_failed' || outcome === 'provider_failed';
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

function resolvePlanModel(plan: PlanRecord, feature: 'chat' | 'image' | 'live_tutor', requestedModel?: string | null): string {
  void feature;
  return resolvePolicyModel(plan.name, requestedModel);
}

function getUsageWindow(plan: PlanRecord, feature: 'chat' | 'image' | 'live_tutor', modelUsed?: string | null, scope: UsageScope = 'day') {
  const now = new Date();
  const policy = getProductPolicy(plan.name);

  if (feature === 'image') {
    const day = getUtcDayWindow(now);
    return {
      windowStart: day.start,
      resetAt: day.end,
      usageLimit: policy.normalChat.imageQuestionsPerDay,
    };
  }

  if (feature === 'live_tutor') {
    return {
      windowStart: getWindowStart(scope),
      resetAt: getResetTime(scope),
      usageLimit: null,
    };
  }

  void modelUsed;
  const day = getUtcDayWindow(now);
  return {
    windowStart: day.start,
    resetAt: day.end,
    usageLimit: policy.normalChat.dailyCompletedMessages,
  };
}

async function getBillingDecision(input: BillingReservationInput): Promise<BillingDecision> {
  const validatedInput = validateBillingReservationInput(input);
  const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
  await ensureDefaultPlans();

  if (validatedInput.feature === 'live_tutor') {
    const liveTutorWallet = await prisma.liveTutorWallet.findUnique({ where: { userId: validatedInput.userId } });
    const availableSeconds = (liveTutorWallet?.minutesBalance ?? 0) * SECONDS_PER_MINUTE;
    
    const allowed = canStartLiveTutorSession({ planEnabled: plan.liveTutorEnabled, availableSeconds, requestedSeconds: validatedInput.amount });
    const reason = !plan.liveTutorEnabled
      ? 'Live Tutor requires an active Pro plan.'
      : allowed
        ? 'Live tutor seconds available.'
        : 'Live tutor balance is exhausted.';
    
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

  // For Gemini (Normal Chat/Image), count BOTH completed AND pending usage
  // This prevents concurrent requests from bypassing budget checks
  let used = await prisma.usageLog.count({
    where: {
      userId: validatedInput.userId,
      feature: toUsageFeature(validatedInput.feature),
      success: true, // Completed only
      createdAt: { gte: windowStart },
    },
  });

  // For Gemini, also count pending (unreserved but in-flight) usage
  if (validatedInput.feature === 'chat' || validatedInput.feature === 'image') {
    const pending = await prisma.usageLog.count({
      where: {
        userId: validatedInput.userId,
        feature: toUsageFeature(validatedInput.feature),
        success: false, // Pending/reserved but not yet finalized
        createdAt: { gte: windowStart },
        metadata: {
          not: {
            path: ['generationOutcome'],
            string_contains: 'cancelled',
          },
        },
      },
    });
    used += pending; // Include pending in total usage for budget check
  }

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
): Promise<{ wallet: { id: string; userId: string; planId: string; planName: string; subscriptionStatus: string; subscriptionStartedAt: Date | null; subscriptionPeriodStart: Date | null; subscriptionExpiresAt: Date | null } | null; plan: PlanRecord }> {
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

  const effectivePlan = isSubscriptionActive(
    wallet.subscriptionStatus as string,
    wallet.subscriptionExpiresAt,
    wallet.subscriptionPeriodStart ?? wallet.subscriptionStartedAt,
  )
    ? planRecord
    : await getFreePlan();

  return {
    wallet: {
      id: wallet.id,
      userId: wallet.userId,
      planId: wallet.planId,
      planName: wallet.plan.name,
      subscriptionStatus: wallet.subscriptionStatus,
      subscriptionStartedAt: wallet.subscriptionStartedAt,
      subscriptionPeriodStart: wallet.subscriptionPeriodStart,
      subscriptionExpiresAt: wallet.subscriptionExpiresAt,
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

async function consumeLiveTutorBalance(
  tx: Prisma.TransactionClient,
  wallet: { id: string; userId: string; includedSeconds: number; topUpSeconds: number },
  seconds: number,
  idempotencyKey: string,
) {
  const { includedUsed, topUpUsed } = allocateLiveTutorConsumption(wallet.includedSeconds, wallet.topUpSeconds, seconds);
  const updated = await tx.liveTutorWallet.update({ where: { userId: wallet.userId }, data: {
    includedSeconds: { decrement: includedUsed },
    topUpSeconds: { decrement: topUpUsed },
    minutesBalance: Math.floor((wallet.includedSeconds + wallet.topUpSeconds - seconds) / SECONDS_PER_MINUTE),
  } });
  await tx.liveTutorMinuteLedger.create({ data: {
    userId: wallet.userId, walletId: wallet.id, idempotencyKey,
    entryType: 'CONSUMPTION', source: 'SYSTEM', includedSecondsDelta: -includedUsed, topUpSecondsDelta: -topUpUsed,
    includedSecondsAfter: updated.includedSeconds, topUpSecondsAfter: updated.topUpSeconds,
  } });
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
): Promise<{ id: string; success: boolean | null; providerCostUSD: number; userChargeUSD: number; profitUSD: number }> {
  const provider = input.provider ?? getDefaultProvider(input.feature);
  const successValue = input.pending
    ? null
    : typeof input.success === 'boolean'
      ? input.success
      : allowed;
  const secondsUsed = typeof input.secondsUsed === 'number' ? input.secondsUsed : (input.feature === 'live_tutor' ? (input.amount ?? 1) * 60 : 0);

  try {
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
        tokensCached: input.tokensCached,
        tokensThinking: input.tokensThinking,
        tokensTotal: input.tokensTotal,
        usageSource: input.usageSource ?? 'UNKNOWN',
        providerCostUSD,
        providerExposureUSD: input.providerExposureUSD ?? 0,
        providerAttemptCount: input.providerAttemptCount ?? 0,
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
    return record;
  } catch (error) {
    logger.error('Billing usage ledger entry failed', { userId: input.userId, requestId: input.requestId, provider, allowed, error });
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

      let resolvedModel = resolvePlanModel(plan, validatedInput.feature, validatedInput.modelUsed);
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

      const budgetSubject = isNormalChatGeminiBudgetSubject(validatedInput);
      const budgetReservation = budgetSubject
        ? await assertAndLockGeminiDailyBudget(tx, { requestId: validatedInput.requestId ?? 'missing-request-id' })
        : null;

      const { wallet, plan: walletPlan } = await resolveWalletAndPlanInTransaction(tx, validatedInput.userId, plan);
      if (!wallet) {
        throw new Error('Failed to initialize billing wallet');
      }

      const effectivePlan = walletPlan;
      // Entitlement may change between the preflight read and this locked
      // transaction. Bind the provider model to the authoritative in-transaction
      // plan so a concurrent revocation cannot retain a Pro-only Flash model.
      resolvedModel = resolvePlanModel(effectivePlan, validatedInput.feature, validatedInput.modelUsed);
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
        const allowed = canStartLiveTutorSession({ planEnabled: effectivePlan.liveTutorEnabled, availableSeconds, requestedSeconds: validatedInput.amount });
        const pendingReservation = validatedInput.pending === true;
        const effectiveAllowed = pendingReservation ? allowed : (validatedInput.success === false ? false : allowed);
        const reason = !effectivePlan.liveTutorEnabled
          ? 'Live Tutor requires an active Pro plan.'
          : pendingReservation
          ? 'Live tutor reservation pending.'
          : effectiveAllowed
            ? 'Live tutor minutes available.'
            : validatedInput.success === false
              ? 'Usage rollback requested.'
              : 'Live tutor minutes are exhausted.';
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, 0, null);
        const metadata = {
          ...validatedInput.metadata,
          amount: validatedInput.amount,
          scope: validatedInput.scope,
          reason,
          requestedBy: validatedInput.userId,
          requestedAt: new Date().toISOString(),
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
          await consumeLiveTutorBalance(tx, liveTutorWallet, validatedInput.amount, `usage:${validatedInput.provider}:${successRecord.id}`);
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
      const pendingCutoff = new Date(Date.now() - 5 * 60 * 1000);
      const usageWhere = {
        userId: validatedInput.userId,
        feature: toUsageFeature(validatedInput.feature),
        OR: [
          { success: true },
          { success: null, createdAt: { gte: pendingCutoff } },
        ],
      } satisfies Prisma.UsageLogWhereInput;
      const used = await tx.usageLog.count({
        where: {
          ...usageWhere,
          createdAt: { gte: windowStart },
        },
      });

      const pendingReservation = validatedInput.pending === true;
      const policy = getProductPolicy(effectivePlan.name);
      const freeMonth = getFreeMonthlyWindow();
      const monthlyStart = effectivePlan.name === 'PRO' && wallet.subscriptionPeriodStart
        ? wallet.subscriptionPeriodStart
        : freeMonth.start;
      const monthlyEnd = effectivePlan.name === 'PRO' && wallet.subscriptionExpiresAt
        ? wallet.subscriptionExpiresAt
        : freeMonth.end;
      const monthlyLimit = validatedInput.feature === 'chat' ? policy.normalChat.monthlyCompletedMessages : null;
      const monthlyUsed = monthlyLimit === null ? 0 : await tx.usageLog.count({
        where: { ...usageWhere, createdAt: { gte: monthlyStart, lt: monthlyEnd } },
      });
      const allowance = validatedInput.feature === 'chat' && typeof usageLimit === 'number' && monthlyLimit !== null
        ? evaluateCompletedAllowance({ dailyUsed: used, monthlyUsed, dailyLimit: usageLimit, monthlyLimit, requested: validatedInput.amount })
        : null;
      const dailyRemaining = allowance?.dailyRemaining ?? (typeof usageLimit === 'number'
        ? Math.max(usageLimit - used - (pendingReservation ? 0 : validatedInput.amount), 0)
        : null);
      const monthlyRemaining = allowance?.monthlyRemaining ?? (monthlyLimit === null
        ? null
        : Math.max(monthlyLimit - monthlyUsed - (pendingReservation ? 0 : validatedInput.amount), 0));
      const remainingUsage = dailyRemaining === null ? monthlyRemaining
        : monthlyRemaining === null ? dailyRemaining
        : Math.min(dailyRemaining, monthlyRemaining);
      const allowed = allowance?.allowed ?? ((typeof usageLimit !== 'number' || used + validatedInput.amount <= usageLimit)
        && (monthlyLimit === null || monthlyUsed + validatedInput.amount <= monthlyLimit));
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
        monthlyWindowStart: monthlyStart.toISOString(),
        monthlyResetAt: monthlyEnd.toISOString(),
        monthlyLimit,
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

      const reservationInput = budgetReservation
        ? {
            ...validatedInput,
            tokensTotal: budgetReservation.reservationTokens,
            usageSource: 'ESTIMATED' as const,
            providerExposureUSD: budgetReservation.reservationCostUSD,
            metadata: {
              ...validatedInput.metadata,
              budgetReservationActive: true,
              budgetReservationCostUSD: budgetReservation.reservationCostUSD,
              budgetReservationTokens: budgetReservation.reservationTokens,
              budgetWindowStart: budgetReservation.windowStart.toISOString(),
              budgetResetTime: budgetReservation.resetTime.toISOString(),
            },
          }
        : validatedInput;
      const reservationMetadata = budgetReservation
        ? {
            ...metadata,
            budgetReservationActive: true,
            budgetReservationCostUSD: budgetReservation.reservationCostUSD,
            budgetReservationTokens: budgetReservation.reservationTokens,
            budgetWindowStart: budgetReservation.windowStart.toISOString(),
            budgetResetTime: budgetReservation.resetTime.toISOString(),
          }
        : metadata;
      const reservedProviderCostUSD = budgetReservation ? 0 : providerCostUSD;
      const successRecord = await createUsageLedgerEntry(
        tx,
        { ...reservationInput, pending: pendingReservation },
        effectivePlan,
        pendingReservation ? false : true,
        reason,
        usage,
        reservedProviderCostUSD,
        userChargeUSD,
        userChargeUSD - reservedProviderCostUSD,
        reservationMetadata,
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
    if (error instanceof GeminiDailyBudgetExceededError) throw error;
    if (error instanceof GeminiDailyBudgetUnavailableError) throw error;
    if (input.provider === 'Gemini' && input.pending && (input.feature === 'chat' || input.feature === 'image')) {
      logger.error('Gemini budget reservation transaction failed closed', {
        requestId: input.requestId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new GeminiDailyBudgetUnavailableError();
    }
    logger.error('Billing usage reservation transaction failed', {
      requestId: input.requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
}

export async function recordGeminiProviderAttempt(input: {
  userId: string;
  requestId: string;
  model: string;
}): Promise<{ attemptNumber: number; model: string }> {
  const policy = getGeminiDailyBudgetPolicy();
  return runTransactionWithRetries(input.userId, async (tx) => {
    const initial = await tx.usageLog.findUnique({
      where: { provider_requestId: { provider: 'Gemini', requestId: input.requestId } },
      select: { id: true },
    });
    if (!initial) throw new Error('Gemini provider attempt requires an existing reservation.');

    await tx.$queryRaw`SELECT id FROM "UsageLog" WHERE id = ${initial.id} FOR UPDATE`;
    const reservation = await tx.usageLog.findUnique({
      where: { id: initial.id },
      select: { id: true, success: true, providerAttemptCount: true },
    });
    if (!reservation || reservation.success !== null) {
      throw new Error('Gemini provider attempt cannot start from a finalized reservation.');
    }

    const additionalAttempt = reservation.providerAttemptCount > 0;
    if (additionalAttempt) {
      await assertAndLockGeminiAdditionalExposure(tx, {
        requestId: input.requestId,
        additionalCostUSD: policy.requestCostReservationUSD,
        additionalTokens: policy.requestTokenReservation,
        policy,
      });
    }

    await tx.usageLog.update({
      where: { id: reservation.id },
      data: {
        providerAttemptCount: { increment: 1 },
        ...(additionalAttempt ? {
          providerExposureUSD: { increment: policy.requestCostReservationUSD },
          tokensTotal: { increment: policy.requestTokenReservation },
        } : {}),
      },
    });
    const attemptNumber = reservation.providerAttemptCount + 1;
    logger.info('Gemini provider attempt started', {
      requestId: input.requestId,
      attemptNumber,
      model: input.model,
      fallbackAttempt: additionalAttempt,
    });
    return { attemptNumber, model: input.model };
  });
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
  const billableOutputTokens = validatedInput.tokensOutput + validatedInput.tokensThinking;
  const providerCostUSD = validatedInput.providerCostUSDOverride ?? (provider === 'Gemini' && validatedInput.usageSource === 'PROVIDER_REPORTED'
    ? (() => {
        if (!validatedInput.modelUsed || !isSupportedNormalChatModel(validatedInput.modelUsed)) {
          throw new Error('Cannot price unsupported Gemini model usage.');
        }
        return calculateGeminiProviderCostUSD({
          model: validatedInput.modelUsed,
          inputTokens: validatedInput.tokensInput,
          outputTokens: validatedInput.tokensOutput,
          cachedTokens: validatedInput.tokensCached,
          thinkingTokens: validatedInput.tokensThinking,
        });
      })()
    : await calculateProviderCost({
        feature: validatedInput.feature,
        provider,
        tokensInput: validatedInput.tokensInput,
        tokensOutput: billableOutputTokens,
        secondsUsed: validatedInput.secondsUsed,
      }));
  const userChargeUSD = await calculateUserCharge({
    feature: validatedInput.feature,
    provider,
    tokensInput: validatedInput.tokensInput,
    tokensOutput: billableOutputTokens,
    secondsUsed: validatedInput.secondsUsed,
  });
  const profitUSD = userChargeUSD - providerCostUSD;
  const finalizedMetadata = provider === 'Gemini'
    ? { ...validatedInput.metadata, pricingSource: GEMINI_PRICING_SOURCE, pricingVersion: GEMINI_PRICING_VERSION }
    : validatedInput.metadata;

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

      if (existing.success === false && isNonCompletedGenerationOutcome(existing.metadata)) {
        const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
        const resolvedModel = resolvePlanModel(plan, validatedInput.feature, existing.modelUsed ?? validatedInput.modelUsed);
        const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
        const used = await tx.usageLog.count({
          where: {
            userId: validatedInput.userId,
            feature: toUsageFeature(validatedInput.feature),
            success: true,
            createdAt: { gte: usageWindow.windowStart },
          },
        });
        const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
        const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);
        return buildDecision(
          false,
          'Non-completed reservation cannot be finalized.',
          usage,
          plan,
          typeof usageLimit === 'number' ? Math.max(usageLimit - used, 0) : null,
          existing.id,
          true,
          existing.providerCostUSD,
          existing.userChargeUSD,
          existing.profitUSD,
          existing.modelUsed ?? resolvedModel,
        );
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
        await consumeLiveTutorBalance(tx, liveTutorWallet, validatedInput.amount, `usage:${provider}:${existing.id}`);
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
        data: {
          success: true,
          modelUsed: validatedInput.modelUsed,
          tokensInput: validatedInput.tokensInput,
          tokensOutput: validatedInput.tokensOutput,
          tokensCached: validatedInput.tokensCached,
          tokensThinking: validatedInput.tokensThinking,
          tokensTotal: validatedInput.usageSource === 'UNKNOWN' ? existing.tokensTotal : validatedInput.tokensTotal,
          usageSource: validatedInput.usageSource,
          providerCostUSD,
          providerExposureUSD: validatedInput.providerExposureUSD
            ?? (validatedInput.usageSource === 'UNKNOWN' ? existing.providerExposureUSD : 0),
          userChargeUSD,
          profitUSD,
          metadata: finalizedMetadata as InputJsonValue,
        },
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
        providerCostUSD,
        userChargeUSD,
        profitUSD,
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

/**
 * Records provider expense for an aborted generation without consuming the
 * learner's completed-message allowance. The provider/request unique key and
 * transaction make repeated cancellation cleanup idempotent across replicas.
 */
async function reconcileNonCompletedUsage(
  input: BillingReservationInput,
  generationOutcome: 'cancelled' | 'persistence_failed' | 'provider_failed',
): Promise<BillingDecision> {
  const validatedInput = validateBillingReservationInput(input);
  if (!validatedInput.requestId) {
    throw new Error('requestId is required for cancellation reconciliation');
  }

  const provider = validatedInput.provider;
  const providerCostUSD = validatedInput.providerCostUSDOverride ?? (provider === 'Gemini' && validatedInput.usageSource === 'PROVIDER_REPORTED'
    ? (() => {
        if (!validatedInput.modelUsed || !isSupportedNormalChatModel(validatedInput.modelUsed)) {
          throw new Error('Cannot price unsupported Gemini model usage.');
        }
        return calculateGeminiProviderCostUSD({
          model: validatedInput.modelUsed,
          inputTokens: validatedInput.tokensInput,
          outputTokens: validatedInput.tokensOutput,
          cachedTokens: validatedInput.tokensCached,
          thinkingTokens: validatedInput.tokensThinking,
        });
      })()
    : 0);
  const outcomeMetadata = provider === 'Gemini'
    ? {
        ...validatedInput.metadata,
        generationOutcome,
        pricingSource: GEMINI_PRICING_SOURCE,
        pricingVersion: GEMINI_PRICING_VERSION,
      }
    : { ...validatedInput.metadata, generationOutcome };

  return runTransactionWithRetries(validatedInput.userId, async (tx) => {
    const existing = await tx.usageLog.findUnique({
      where: { provider_requestId: { provider, requestId: validatedInput.requestId! } },
    });
    if (!existing) {
      throw new Error('Cannot reconcile a cancellation without a usage reservation.');
    }

    const alreadyReconciled = existing.success === false && getGenerationOutcome(existing.metadata) === generationOutcome;
    if (existing.success !== true && !alreadyReconciled) {
      await tx.usageLog.update({
        where: { id: existing.id },
        data: {
          success: false,
          modelUsed: validatedInput.modelUsed,
          tokensInput: validatedInput.tokensInput,
          tokensOutput: validatedInput.tokensOutput,
          tokensCached: validatedInput.tokensCached,
          tokensThinking: validatedInput.tokensThinking,
          tokensTotal: validatedInput.usageSource === 'UNKNOWN' ? existing.tokensTotal : validatedInput.tokensTotal,
          usageSource: validatedInput.usageSource,
          providerCostUSD,
          providerExposureUSD: validatedInput.providerExposureUSD
            ?? (validatedInput.usageSource === 'UNKNOWN' && existing.providerAttemptCount > 0 ? existing.providerExposureUSD : 0),
          userChargeUSD: 0,
          profitUSD: -providerCostUSD,
          metadata: outcomeMetadata as InputJsonValue,
        },
      });
    }

    const record = alreadyReconciled || existing.success === true
      ? existing
      : {
          ...existing,
          success: false,
          modelUsed: validatedInput.modelUsed,
          providerCostUSD,
          userChargeUSD: 0,
          profitUSD: -providerCostUSD,
        };
    const plan = validatedInput.planOverride ?? await getEffectivePlanForUser(validatedInput.userId);
    const resolvedModel = resolvePlanModel(plan, validatedInput.feature, record.modelUsed ?? validatedInput.modelUsed);
    const usageWindow = getUsageWindow(plan, validatedInput.feature, resolvedModel, validatedInput.scope);
    const used = await tx.usageLog.count({
      where: {
        userId: validatedInput.userId,
        feature: toUsageFeature(validatedInput.feature),
        success: true,
        createdAt: { gte: usageWindow.windowStart },
      },
    });
    const usageLimit = getEffectiveLimit(plan, validatedInput.feature === 'image' ? 'image' : 'chat', { modelUsed: resolvedModel });
    const usage = buildUsageSnapshot(validatedInput.feature, validatedInput.scope, used, usageLimit, usageWindow.resetAt);
    return buildDecision(
      existing.success === true,
      existing.success === true ? 'Completed reservation was already finalized.' : 'Non-completed usage reconciled.',
      usage,
      plan,
      typeof usageLimit === 'number' ? Math.max(usageLimit - used, 0) : null,
      existing.id,
      alreadyReconciled || existing.success === true,
      record.providerCostUSD,
      record.userChargeUSD,
      record.profitUSD,
      record.modelUsed ?? resolvedModel,
    );
  });
}

export async function reconcileCancelledUsage(input: BillingReservationInput): Promise<BillingDecision> {
  return reconcileNonCompletedUsage(input, 'cancelled');
}

export async function reconcilePersistenceFailureUsage(input: BillingReservationInput): Promise<BillingDecision> {
  return reconcileNonCompletedUsage(input, 'persistence_failed');
}

export async function reconcileProviderFailureUsage(input: BillingReservationInput): Promise<BillingDecision> {
  return reconcileNonCompletedUsage(input, 'provider_failed');
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
        data: {
          success: false,
          ...(provider === 'Gemini' && existing.providerAttemptCount === 0 ? {
            providerCostUSD: 0,
            providerExposureUSD: 0,
            tokensInput: 0,
            tokensOutput: 0,
            tokensCached: 0,
            tokensThinking: 0,
            tokensTotal: 0,
            usageSource: 'UNKNOWN',
            userChargeUSD: 0,
            profitUSD: 0,
            metadata: {
              ...(existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
                ? existing.metadata as Prisma.JsonObject
                : {}),
              ...validatedInput.metadata,
              generationOutcome: 'rolled_back_before_provider',
            } as InputJsonValue,
          } : {}),
        },
      });

      if (provider === 'Gemini' && existing.providerAttemptCount === 0) {
        logger.info('Gemini reservation released before provider invocation', {
          requestId: validatedInput.requestId,
        });
      }

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

