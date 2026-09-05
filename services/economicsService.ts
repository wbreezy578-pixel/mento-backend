import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getEffectiveLimit, getPlan } from './planService';

export type BillingPlan = 'FREE' | 'PRO';
export type UsageFeature = 'chat' | 'live_tutor' | 'speech' | 'image' | string;
export type UsageProvider = 'Gemini' | 'Simli' | 'OpenAI' | 'Azure' | 'ImageGen' | string;

export interface PlanLimits {
  dailyChatLimit: number;
  monthlyChatLimit: number | null;
}

export interface UsageLogInput {
  userId: string;
  feature: UsageFeature;
  provider: UsageProvider;
  requestId?: string;
  tokensInput?: number;
  tokensOutput?: number;
  secondsUsed?: number;
  providerCostUSD?: number;
  userChargeUSD?: number;
  profitUSD?: number;
}

export interface PricingConfigValue {
  key: string;
  value: number;
  description?: string | null;
}

export interface WalletSummary {
  id: string;
  userId: string;
  plan: BillingPlan;
  liveTutorMinutesBalance: number;
  subscriptionStatus: string;
  dailyChatLimit: number;
  dailyChatUsed: number;
  dailyChatRemaining: number;
  createdAt: string;
  updatedAt: string;
}

export interface UsageLogSummary {
  id: string;
  userId: string;
  feature: string;
  provider: string;
  requestId: string | null;
  tokensInput: number;
  tokensOutput: number;
  secondsUsed: number;
  providerCostUSD: number;
  userChargeUSD: number;
  profitUSD: number;
  createdAt: string;
}

export interface EconomicsStats {
  totalRevenue: number;
  providerCosts: number;
  totalProfit: number;
  usageCounts: Record<string, number>;
  activeUsers: number;
}

const DEFAULT_PRICING: Record<string, number> = {
  chat_input_token_cost_usd: 0.000001,
  chat_output_token_cost_usd: 0.000002,
  speech_second_cost_usd: 0.0005,
  image_generation_cost_usd: 0.02,
  live_tutor_second_cost_usd: 0.0008333333333,
  chat_charge_multiplier: 2.5,
  speech_charge_multiplier: 1.1,
  image_charge_multiplier: 1.1,
  live_tutor_charge_multiplier: 1.1,
  free_learning_credits: 100,
  free_live_tutor_credits: 10,
  pro_learning_credits: 1000,
  pro_live_tutor_credits: 100,
  premium_learning_credits: 5000,
  premium_live_tutor_credits: 500,
};

function toNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const PRICING_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedPricing: Record<string, number> | null = null;
let pricingCacheExpiresAt: number | null = null;
let pricingCachePromise: Promise<Record<string, number>> | null = null;

async function initializePricingConfig(): Promise<Record<string, number>> {
  if (cachedPricing && pricingCacheExpiresAt && Date.now() < pricingCacheExpiresAt) {
    return cachedPricing;
  }

  if (pricingCachePromise) {
    return pricingCachePromise;
  }

  pricingCachePromise = (async () => {
    const keys = Object.keys(DEFAULT_PRICING);
    const data = keys.map((key) => ({ key, value: DEFAULT_PRICING[key] }));
    await prisma.pricingConfig.createMany({ data, skipDuplicates: true });

    const rows = await prisma.pricingConfig.findMany({
      where: { key: { in: keys } },
    });

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }

    for (const key of keys) {
      if (result[key] === undefined) {
        result[key] = DEFAULT_PRICING[key];
      }
    }

    cachedPricing = result;
    pricingCacheExpiresAt = Date.now() + PRICING_CACHE_TTL_MS;
    return result;
  })();

  try {
    return await pricingCachePromise;
  } finally {
    pricingCachePromise = null;
  }
}

async function getPricingConfig(): Promise<Record<string, number>> {
  return initializePricingConfig();
}

export async function getPlanLimits(plan: BillingPlan | string | null | undefined): Promise<PlanLimits> {
  const normalizedPlan = typeof plan === 'string' ? plan.toUpperCase() : 'FREE';
  const planRecord = await getPlan(normalizedPlan);

  if (!planRecord) {
    return {
      dailyChatLimit: 0,
      monthlyChatLimit: null,
    };
  }

  const dailyChatLimit = getEffectiveLimit(planRecord, 'chat') ?? 0;
  return {
    dailyChatLimit,
    monthlyChatLimit: dailyChatLimit,
  };
}

export async function countDailyChatUsage(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  return await prisma.usageLog.count({
    where: {
      userId,
      feature: 'chat',
      provider: 'Gemini',
      createdAt: { gte: startOfDay },
    },
  });
}

export async function canUseAIChat(userId: string, amount = 1) {
  const wallet = await ensureWallet(userId);
  const planLimits = await getPlanLimits(wallet.plan);
  const used = await countDailyChatUsage(userId);
  const remaining = Math.max(planLimits.dailyChatLimit - used, 0);

  if (used + amount > planLimits.dailyChatLimit) {
    return {
      ok: false,
      message: `Daily AI request limit reached for the ${wallet.plan} plan. Upgrade to Pro for more usage.`,
      status: 402,
      limit: planLimits.dailyChatLimit,
      used,
      remaining,
    };
  }

  return {
    ok: true,
    limit: planLimits.dailyChatLimit,
    used,
    remaining: Math.max(remaining - amount, 0),
  };
}

export async function calculateProviderCost(input: {
  feature: UsageFeature;
  provider: UsageProvider;
  tokensInput?: number;
  tokensOutput?: number;
  secondsUsed?: number;
}): Promise<number> {
  const pricing = await getPricingConfig();
  const inputTokens = toNumber(input.tokensInput);
  const outputTokens = toNumber(input.tokensOutput);
  const seconds = toNumber(input.secondsUsed);

  switch (input.feature) {
    case 'chat':
      return inputTokens * pricing.chat_input_token_cost_usd + outputTokens * pricing.chat_output_token_cost_usd;
    case 'speech':
      return seconds * pricing.speech_second_cost_usd;
    case 'image':
      return pricing.image_generation_cost_usd;
    case 'live_tutor':
      return seconds * pricing.live_tutor_second_cost_usd;
    default:
      return 0;
  }
}

export async function calculateUserCharge(input: {
  feature: UsageFeature;
  provider: UsageProvider;
  tokensInput?: number;
  tokensOutput?: number;
  secondsUsed?: number;
}): Promise<number> {
  const providerCost = await calculateProviderCost(input);
  const pricing = await getPricingConfig();
  const multiplierKey = `${input.feature}_charge_multiplier`;
  const multiplier = pricing[multiplierKey] ?? 1;

  return providerCost * multiplier;
}

export async function calculateProfit(input: {
  feature: UsageFeature;
  provider: UsageProvider;
  tokensInput?: number;
  tokensOutput?: number;
  secondsUsed?: number;
}): Promise<number> {
  const providerCost = await calculateProviderCost(input);
  const userCharge = await calculateUserCharge(input);
  return userCharge - providerCost;
}

export async function getWallet(userId: string): Promise<WalletSummary | null> {
  const wallet = await prisma.userWallet.findUnique({
    where: { userId },
    include: { plan: true },
  });
  if (!wallet) {
    return null;
  }

  const liveTutorWallet = await prisma.liveTutorWallet.findUnique({ where: { userId } });
  const planName = (wallet.plan?.name as BillingPlan | undefined) ?? 'FREE';
  const planLimits = await getPlanLimits(planName);
  const dailyChatUsed = await countDailyChatUsage(userId);

  return {
    id: wallet.id,
    userId: wallet.userId,
    plan: planName,
    liveTutorMinutesBalance: liveTutorWallet?.minutesBalance ?? 0,
    subscriptionStatus: wallet.subscriptionStatus,
    dailyChatLimit: planLimits.dailyChatLimit,
    dailyChatUsed,
    dailyChatRemaining: Math.max(planLimits.dailyChatLimit - dailyChatUsed, 0),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export async function ensureUserBillingSetup(userId: string): Promise<WalletSummary> {
  const freePlan = await prisma.plan.upsert({
    where: { name: 'FREE' },
    update: {},
    create: { name: 'FREE', price: 0 },
  });

  await prisma.userWallet.upsert({
    where: { userId },
    update: {
      plan: { connect: { id: freePlan.id } },
      subscriptionStatus: 'active',
    },
    create: {
      user: {
        connect: { id: userId },
      },
      plan: {
        connect: { id: freePlan.id },
      },
      subscriptionStatus: 'active',
    },
  });

  await prisma.liveTutorWallet.upsert({
    where: { userId },
    update: {},
    create: {
      user: {
        connect: { id: userId },
      },
      minutesBalance: 0,
    },
  });

  return await getWallet(userId) as WalletSummary;
}

export async function ensureWallet(userId: string): Promise<WalletSummary> {
  return ensureUserBillingSetup(userId);
}

export async function deductCredits(userId: string, options: { feature: UsageFeature; amount?: number }): Promise<boolean> {
  await ensureUserBillingSetup(userId);
  const amount = options.amount ?? 1;

  if (options.feature === 'live_tutor') {
    const liveTutorWallet = await prisma.liveTutorWallet.findUnique({ where: { userId } });
    if (!liveTutorWallet || liveTutorWallet.minutesBalance < amount) {
      return false;
    }

    await prisma.liveTutorWallet.update({
      where: { userId },
      data: { minutesBalance: { decrement: amount } },
    });
    return true;
  }

  return true;
}

export async function addCredits(userId: string, options: { feature: UsageFeature; amount?: number }): Promise<WalletSummary> {
  await ensureUserBillingSetup(userId);
  const amount = options.amount ?? 1;

  if (options.feature === 'live_tutor') {
    await prisma.liveTutorWallet.update({
      where: { userId },
      data: { minutesBalance: { increment: amount } },
    });
  }

  return await getWallet(userId) as WalletSummary;
}

export async function logUsage(input: UsageLogInput): Promise<UsageLogSummary> {
  const providerCost = await calculateProviderCost({
    feature: input.feature,
    provider: input.provider,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    secondsUsed: input.secondsUsed,
  });

  const userCharge = input.userChargeUSD ?? await calculateUserCharge({
    feature: input.feature,
    provider: input.provider,
    tokensInput: input.tokensInput,
    tokensOutput: input.tokensOutput,
    secondsUsed: input.secondsUsed,
  });

  const profit = input.profitUSD ?? (userCharge - providerCost);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (input.requestId) {
      const existing = await tx.usageLog.findFirst({ where: { userId: input.userId, provider: input.provider, requestId: input.requestId } });
      if (existing) {
        return {
          id: existing.id,
          userId: existing.userId,
          feature: existing.feature,
          provider: existing.provider,
          requestId: existing.requestId,
          tokensInput: existing.tokensInput,
          tokensOutput: existing.tokensOutput,
          secondsUsed: existing.secondsUsed,
          providerCostUSD: existing.providerCostUSD,
          userChargeUSD: existing.userChargeUSD,
          profitUSD: existing.profitUSD,
          createdAt: existing.createdAt.toISOString(),
        };
      }
    }

    const record = await tx.usageLog.create({
      data: {
        userId: input.userId,
        feature: input.feature,
        provider: input.provider,
        requestId: input.requestId,
        tokensInput: input.tokensInput ?? 0,
        tokensOutput: input.tokensOutput ?? 0,
        secondsUsed: input.secondsUsed ?? 0,
        providerCostUSD: providerCost,
        userChargeUSD: userCharge,
        profitUSD: profit,
      },
    });

    const wallet = await tx.userWallet.findUnique({ where: { userId: input.userId } });
    if (!wallet) {
      await tx.userWallet.create({
        data: {
          user: { connect: { id: input.userId } },
          plan: { connect: { name: 'FREE' } },
          subscriptionStatus: 'active',
        },
      });
    }

    return {
      id: record.id,
      userId: record.userId,
      feature: record.feature,
      provider: record.provider,
      requestId: record.requestId,
      tokensInput: record.tokensInput,
      tokensOutput: record.tokensOutput,
      secondsUsed: record.secondsUsed,
      providerCostUSD: record.providerCostUSD,
      userChargeUSD: record.userChargeUSD,
      profitUSD: record.profitUSD,
      createdAt: record.createdAt.toISOString(),
    };
  });
}

export async function getWalletHistory(userId: string): Promise<UsageLogSummary[]> {
  const logs = await prisma.usageLog.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return logs.map((log: (typeof logs)[number]) => ({
    id: log.id,
    userId: log.userId,
    feature: log.feature,
    provider: log.provider,
    requestId: log.requestId,
    tokensInput: log.tokensInput,
    tokensOutput: log.tokensOutput,
    secondsUsed: log.secondsUsed,
    providerCostUSD: log.providerCostUSD,
    userChargeUSD: log.userChargeUSD,
    profitUSD: log.profitUSD,
    createdAt: log.createdAt.toISOString(),
  }));
}

export async function getWalletUsage(userId: string): Promise<UsageLogSummary[]> {
  return getWalletHistory(userId);
}

export async function getEconomicsStats(): Promise<EconomicsStats> {
  const [revenue, costs, profit, usageCountRows, activeUsers] = await Promise.all([
    prisma.usageLog.aggregate({ _sum: { userChargeUSD: true } }),
    prisma.usageLog.aggregate({ _sum: { providerCostUSD: true } }),
    prisma.usageLog.aggregate({ _sum: { profitUSD: true } }),
    prisma.usageLog.groupBy({
      by: ['feature'],
      _count: { _all: true },
    }),
    prisma.userWallet.count({ where: { subscriptionStatus: { not: 'inactive' } } }),
  ]);

  const usageCounts = Object.fromEntries(
    usageCountRows.map((entry: { feature: string; _count: { _all: number } }) => [entry.feature, entry._count._all])
  );

  return {
    totalRevenue: toNumber(revenue._sum.userChargeUSD),
    providerCosts: toNumber(costs._sum.providerCostUSD),
    totalProfit: toNumber(profit._sum.profitUSD),
    usageCounts,
    activeUsers,
  };
}

export async function listPricingConfig(): Promise<PricingConfigValue[]> {
  const records = await prisma.pricingConfig.findMany({ orderBy: { key: 'asc' } });
  return records.map((entry: { key: string; value: number; description: string | null }) => ({
    key: entry.key,
    value: entry.value,
    description: entry.description,
  }));
}

export async function setPricingConfig(values: PricingConfigValue[]): Promise<PricingConfigValue[]> {
  await Promise.all(values.map(async (entry) => {
    await prisma.pricingConfig.upsert({
      where: { key: entry.key },
      update: { value: entry.value, description: entry.description ?? null },
      create: { key: entry.key, value: entry.value, description: entry.description ?? null },
    });
  }));

  return listPricingConfig();
}
