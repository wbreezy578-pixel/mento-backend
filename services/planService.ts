import type { InputJsonValue, JsonValue } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma';
import { getProductPolicy } from './productPolicy';

export type BillingPlanName = 'FREE' | 'PRO';

export interface PlanRecord {
  id: string;
  name: string;
  price: number;
  messageLimit: number | null;
  imageLimit: number | null;
  chatModel: string;
  fairUseEnabled: boolean;
  imageDailyLimit: number;
  priority: number;
  liveTutorEnabled: boolean;
  features: Record<string, unknown>;
}

interface PlanDefinition {
  name: BillingPlanName;
  price: number;
  messageLimit: number | null;
  imageLimit: number | null;
  chatModel: string;
  fairUseEnabled: boolean;
  imageDailyLimit: number;
  priority: number;
  liveTutorEnabled: boolean;
  features: Record<string, unknown>;
}

export class PlanServiceError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PlanServiceError';
    this.code = code;
    this.details = details;
  }
}

const freePolicy = getProductPolicy('FREE');
const proPolicy = getProductPolicy('PRO');

const DEFAULT_PLAN_DEFINITIONS: PlanDefinition[] = [
  {
    name: 'FREE',
    price: 0,
    messageLimit: null,
    imageLimit: null,
    chatModel: freePolicy.normalChat.model,
    fairUseEnabled: true,
    imageDailyLimit: 3,
    priority: 0,
    liveTutorEnabled: false,
    features: {
      chatModel: freePolicy.normalChat.model,
      imageModel: freePolicy.normalChat.model,
      availableModels: [...freePolicy.normalChat.allowedModels],
      chatDailyLimit: freePolicy.normalChat.dailyCompletedMessages,
      chatMonthlyLimit: freePolicy.normalChat.monthlyCompletedMessages,
      fairUseChatLimit: freePolicy.normalChat.dailyCompletedMessages,
      fairUseImageLimit: freePolicy.normalChat.imageQuestionsPerDay,
      imageDailyLimit: freePolicy.normalChat.imageQuestionsPerDay,
      liveTutorEnabled: false,
    },
  },
  {
    name: 'PRO',
    price: proPolicy.priceMonthlyUSD,
    messageLimit: null,
    imageLimit: null,
    chatModel: proPolicy.normalChat.model,
    fairUseEnabled: true,
    imageDailyLimit: proPolicy.normalChat.imageQuestionsPerDay,
    priority: 1,
    liveTutorEnabled: true,
    features: {
      chatModel: proPolicy.normalChat.model,
      imageModel: proPolicy.normalChat.model,
      availableModels: [...proPolicy.normalChat.allowedModels],
      chatDailyLimit: proPolicy.normalChat.dailyCompletedMessages,
      chatMonthlyLimit: proPolicy.normalChat.monthlyCompletedMessages,
      proChatDailyLimit: proPolicy.normalChat.dailyCompletedMessages,
      fairUseChatLimit: proPolicy.normalChat.dailyCompletedMessages,
      fairUseImageLimit: proPolicy.normalChat.imageQuestionsPerDay,
      imageDailyLimit: proPolicy.normalChat.imageQuestionsPerDay,
      liveTutorEnabled: true,
      includedLiveTutorSeconds: proPolicy.liveTutor.includedSecondsPerPeriod,
      liveTutorMaxSessionSeconds: proPolicy.liveTutor.maxSessionSeconds,
    },
  },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedPlans: PlanRecord[] | null = null;
let cacheExpiresAt: number | null = null;
let cachePromise: Promise<PlanRecord[]> | null = null;

function normalizePlanName(name: string | null | undefined): BillingPlanName {
  if (name === 'PRO') {
    return 'PRO';
  }
  return 'FREE';
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toPlanRecord(plan: {
  id: string;
  name: string;
  price: number;
  messageLimit: number | null;
  imageLimit: number | null;
  chatModel: string;
  fairUseEnabled: boolean;
  imageDailyLimit: number;
  priority: number;
  liveTutorEnabled: boolean;
  features: JsonValue | null;
}): PlanRecord {
  return {
    id: plan.id,
    name: plan.name,
    price: plan.price,
    messageLimit: plan.messageLimit,
    imageLimit: plan.imageLimit,
    chatModel: plan.chatModel,
    fairUseEnabled: plan.fairUseEnabled,
    imageDailyLimit: plan.imageDailyLimit,
    priority: plan.priority,
    liveTutorEnabled: plan.liveTutorEnabled,
    features: toRecord(plan.features),
  };
}

function normalizeError(error: unknown, fallbackCode: string, fallbackMessage: string): never {
  if (error instanceof PlanServiceError) {
    throw error;
  }

  if (error instanceof Error) {
    throw new PlanServiceError(fallbackCode, fallbackMessage, { message: error.message, cause: error.name });
  }

  throw new PlanServiceError(fallbackCode, fallbackMessage, { cause: String(error) });
}

async function ensureSeedPlans(): Promise<void> {
  const planData = DEFAULT_PLAN_DEFINITIONS.map((definition) => ({
    name: definition.name,
    price: definition.price,
    messageLimit: definition.messageLimit,
    imageLimit: definition.imageLimit,
    chatModel: definition.chatModel,
    fairUseEnabled: definition.fairUseEnabled,
    imageDailyLimit: definition.imageDailyLimit,
    priority: definition.priority,
    liveTutorEnabled: definition.liveTutorEnabled,
    features: definition.features as InputJsonValue,
  }));

  for (const plan of planData) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: {
        price: plan.price,
        messageLimit: plan.messageLimit,
        imageLimit: plan.imageLimit,
        chatModel: plan.chatModel,
        fairUseEnabled: plan.fairUseEnabled,
        imageDailyLimit: plan.imageDailyLimit,
        priority: plan.priority,
        liveTutorEnabled: plan.liveTutorEnabled,
        features: plan.features,
      },
      create: plan,
    });
  }
}

async function loadPlansFromDatabase(force = false): Promise<PlanRecord[]> {
  if (!force && cachedPlans && cacheExpiresAt && Date.now() < cacheExpiresAt) {
    return cachedPlans;
  }

  if (!force && cachePromise) {
    return cachePromise;
  }

  cachePromise = (async () => {
    await ensureSeedPlans();

    const plans = await prisma.plan.findMany({
      where: {
        name: { in: DEFAULT_PLAN_DEFINITIONS.map((definition) => definition.name) },
      },
      orderBy: { priority: 'asc' },
    });

    if (plans.length === 0) {
      throw new PlanServiceError('PLAN_NOT_FOUND', 'No plans were found in the database.', { source: 'database' });
    }

    const mappedPlans = plans.map(toPlanRecord);
    cachedPlans = mappedPlans;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return mappedPlans;
  })();

  try {
    return await cachePromise;
  } catch (error) {
    cachedPlans = null;
    cacheExpiresAt = null;
    throw error instanceof PlanServiceError
      ? error
      : new PlanServiceError('CACHE_REFRESH_FAILED', 'Failed to refresh the plan cache.', { cause: error });
  } finally {
    cachePromise = null;
  }
}

export async function ensureDefaultPlans(): Promise<PlanRecord[]> {
  try {
    return loadPlansFromDatabase();
  } catch (error) {
    normalizeError(error, 'PLAN_INIT_FAILED', 'Failed to ensure default plans exist.');
  }
}

export async function refreshCache(): Promise<PlanRecord[]> {
  return loadPlansFromDatabase(true);
}

export async function getPlan(name: string | null | undefined): Promise<PlanRecord | null> {
  const normalizedName = normalizePlanName(name);
  const plans = await loadPlansFromDatabase();
  return plans.find((plan) => plan.name === normalizedName) ?? null;
}

export async function getPlanByName(name: string): Promise<PlanRecord | null> {
  return getPlan(name);
}

export async function getPlanById(id: string): Promise<PlanRecord | null> {
  const plans = await loadPlansFromDatabase();
  return plans.find((plan) => plan.id === id) ?? null;
}

export async function getFreePlan(): Promise<PlanRecord> {
  const plan = await getPlan('FREE');
  if (!plan) {
    throw new PlanServiceError('PLAN_NOT_FOUND', 'The FREE plan could not be found.', { planName: 'FREE' });
  }
  return plan;
}

export async function getProPlan(): Promise<PlanRecord> {
  const plan = await getPlan('PRO');
  if (!plan) {
    throw new PlanServiceError('PLAN_NOT_FOUND', 'The PRO plan could not be found.', { planName: 'PRO' });
  }
  return plan;
}

export function isSubscriptionActive(
  status: string | null | undefined,
  expiresAt?: Date | string | null,
  startsAt?: Date | string | null,
  now = new Date(),
): boolean {
  const normalizedStatus = String(status ?? '').toLowerCase();
  const accessStatuses = new Set(['active', 'trialing', 'grace_period', 'grace', 'canceled', 'cancelled']);
  if (accessStatuses.has(normalizedStatus) && expiresAt && startsAt) {
    const expiration = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
    const start = typeof startsAt === 'string' ? new Date(startsAt) : startsAt;
    return expiration instanceof Date
      && !Number.isNaN(expiration.getTime())
      && expiration > now
      && !Number.isNaN(start.getTime())
      && start <= now;
  }

  return false;
}

export async function getPlanForUser(userId: string): Promise<PlanRecord> {
  await ensureDefaultPlans();

  const wallet = await prisma.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (wallet?.plan) {
    return toPlanRecord(wallet.plan);
  }

  return getFreePlan();
}

export async function getEffectivePlanForUser(userId: string): Promise<PlanRecord> {
  await ensureDefaultPlans();

  const wallet = await prisma.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (!wallet?.plan) {
    return getFreePlan();
  }

  if (isSubscriptionActive(
    wallet.subscriptionStatus as string,
    wallet.subscriptionExpiresAt,
    wallet.subscriptionPeriodStart ?? wallet.subscriptionStartedAt,
  )) {
    return toPlanRecord(wallet.plan);
  }

  return getFreePlan();
}

export function getEffectiveLimit(
  plan: PlanRecord,
  feature: 'chat' | 'image',
  options?: { modelUsed?: string | null },
): number | null {
  if (feature === 'chat') {
    if (typeof plan.messageLimit === 'number') {
      return plan.messageLimit;
    }

    void options;
    return toNumber(plan.features.chatDailyLimit) ?? toNumber(plan.features.fairUseChatLimit);
  }

  if (feature === 'image') {
    if (typeof plan.imageLimit === 'number') {
      return plan.imageLimit;
    }

    const imageDailyLimit = toNumber(plan.features.imageDailyLimit);
    if (imageDailyLimit !== null) {
      return imageDailyLimit;
    }

    const fairUseLimit = toNumber(plan.features.fairUseImageLimit);
    return fairUseLimit ?? null;
  }

  return null;
}

export function isFairUseEnabled(plan: PlanRecord): boolean {
  return plan.fairUseEnabled || plan.features.fairUseEnabled === true;
}

export function getFeatureFlag(plan: PlanRecord, key: string, fallback = false): boolean {
  const directValue = plan.features[key];
  if (typeof directValue === 'boolean') return directValue;
  if (typeof directValue === 'string') return directValue === 'true';
  return fallback;
}

export function getPlanDisplayName(name: string | null | undefined): string {
  return normalizePlanName(name);
}
