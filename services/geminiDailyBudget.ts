import type { Prisma } from '@prisma/client';
import logger from '../lib/logger';

const GEMINI_DAILY_BUDGET_LOCK_KEY = '5572607161547801';
const DEFAULT_DAILY_COST_LIMIT_USD = 10;
const DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000;
const DEFAULT_REQUEST_COST_RESERVATION_USD = 0.5;
const DEFAULT_REQUEST_TOKEN_RESERVATION = 100_000;

export type GeminiDailyBudgetPolicy = {
  costLimitUSD: number;
  tokenLimit: number;
  requestCostReservationUSD: number;
  requestTokenReservation: number;
};

export class GeminiDailyBudgetExceededError extends Error {
  readonly code = 'gemini_daily_budget_exceeded';
  readonly resetTime: string;

  constructor(resetTime: string) {
    super('Gemini daily provider budget reached.');
    this.name = 'GeminiDailyBudgetExceededError';
    this.resetTime = resetTime;
  }
}

export class GeminiDailyBudgetUnavailableError extends Error {
  readonly code = 'gemini_daily_budget_unavailable';

  constructor() {
    super('Gemini daily provider budget could not be checked safely.');
    this.name = 'GeminiDailyBudgetUnavailableError';
  }
}

function positiveNumber(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getGeminiDailyBudgetPolicy(env: NodeJS.ProcessEnv = process.env): GeminiDailyBudgetPolicy {
  return {
    costLimitUSD: positiveNumber(env.AI_DAILY_COST_LIMIT_USD, DEFAULT_DAILY_COST_LIMIT_USD),
    tokenLimit: Math.floor(positiveNumber(env.AI_DAILY_TOKEN_LIMIT, DEFAULT_DAILY_TOKEN_LIMIT)),
    requestCostReservationUSD: positiveNumber(
      env.AI_GEMINI_REQUEST_COST_RESERVATION_USD,
      DEFAULT_REQUEST_COST_RESERVATION_USD,
    ),
    requestTokenReservation: Math.floor(positiveNumber(
      env.AI_GEMINI_REQUEST_TOKEN_RESERVATION,
      DEFAULT_REQUEST_TOKEN_RESERVATION,
    )),
  };
}

export function getGeminiDailyBudgetWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    start,
    reset: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  };
}

export function isNormalChatGeminiBudgetSubject(input: {
  provider: string;
  feature: 'chat' | 'image' | 'live_tutor';
  pending: boolean;
}) {
  return input.provider === 'Gemini'
    && input.pending
    && (input.feature === 'chat' || input.feature === 'image');
}

type BudgetTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | 'usageLog'>;

/**
 * Must run in the same database transaction that creates the UsageLog
 * reservation. The transaction-scoped PostgreSQL advisory lock serializes
 * this provider-wide boundary across every backend replica.
 */
export async function assertAndLockGeminiDailyBudget(
  tx: BudgetTransaction,
  input: {
    requestId: string;
    policy?: GeminiDailyBudgetPolicy;
    now?: Date;
  },
) {
  const policy = input.policy ?? getGeminiDailyBudgetPolicy();
  return assertAndLockGeminiAdditionalExposure(tx, {
    requestId: input.requestId,
    policy,
    now: input.now,
    additionalCostUSD: policy.requestCostReservationUSD,
    additionalTokens: policy.requestTokenReservation,
  });
}

export async function assertAndLockGeminiAdditionalExposure(
  tx: BudgetTransaction,
  input: {
    requestId: string;
    additionalCostUSD: number;
    additionalTokens: number;
    policy?: GeminiDailyBudgetPolicy;
    now?: Date;
  },
) {
  const policy = input.policy ?? getGeminiDailyBudgetPolicy();
  const window = getGeminiDailyBudgetWindow(input.now);

  try {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(CAST(${GEMINI_DAILY_BUDGET_LOCK_KEY} AS bigint))`;
    const spend = await tx.usageLog.aggregate({
      where: {
        provider: 'Gemini',
        createdAt: { gte: window.start },
        OR: [
          { success: true },
          { success: null },
          {
            success: false,
            OR: [
              { metadata: { path: ['generationOutcome'], equals: 'cancelled' } },
              { metadata: { path: ['generationOutcome'], equals: 'persistence_failed' } },
              { metadata: { path: ['generationOutcome'], equals: 'provider_failed' } },
            ],
          },
        ],
      },
      _sum: { providerCostUSD: true, providerExposureUSD: true, tokensTotal: true },
    });
    const currentCostUSD = (spend._sum?.providerCostUSD ?? 0) + (spend._sum?.providerExposureUSD ?? 0);
    const currentTokens = spend._sum?.tokensTotal ?? 0;
    const projectedCostUSD = currentCostUSD + Math.max(0, input.additionalCostUSD);
    const projectedTokens = currentTokens + Math.max(0, input.additionalTokens);
    const blocked = currentCostUSD >= policy.costLimitUSD
      || currentTokens >= policy.tokenLimit
      || projectedCostUSD > policy.costLimitUSD
      || projectedTokens > policy.tokenLimit;

    if (blocked) {
      logger.warn('Gemini daily budget blocked generation', {
        requestId: input.requestId,
        resetTime: window.reset.toISOString(),
        costThresholdReached: projectedCostUSD > policy.costLimitUSD,
        tokenThresholdReached: projectedTokens > policy.tokenLimit,
      });
      throw new GeminiDailyBudgetExceededError(window.reset.toISOString());
    }

    logger.info('Gemini daily budget check passed', {
      requestId: input.requestId,
      resetTime: window.reset.toISOString(),
      utilizationBand: currentCostUSD >= policy.costLimitUSD * 0.8 ? 'high' : 'normal',
    });
    if (currentCostUSD >= policy.costLimitUSD * 0.8 || currentTokens >= policy.tokenLimit * 0.8) {
      logger.warn('Gemini daily budget threshold reached', {
        requestId: input.requestId,
        resetTime: window.reset.toISOString(),
        costThreshold: currentCostUSD >= policy.costLimitUSD * 0.8,
        tokenThreshold: currentTokens >= policy.tokenLimit * 0.8,
      });
    }
    return {
      reservationCostUSD: Math.max(0, input.additionalCostUSD),
      reservationTokens: Math.max(0, input.additionalTokens),
      windowStart: window.start,
      resetTime: window.reset,
    };
  } catch (error) {
    if (error instanceof GeminiDailyBudgetExceededError) throw error;
    logger.error('Gemini daily budget infrastructure unavailable', {
      requestId: input.requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new GeminiDailyBudgetUnavailableError();
  }
}
