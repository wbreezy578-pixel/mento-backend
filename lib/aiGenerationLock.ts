import { getRedisUrl } from './env';
import logger from './logger';
import { createRedisClient, type MentoRedisClient } from './redisClient';

const GENERATION_LOCK_TTL_MS = Math.max(30_000, Number.parseInt(process.env.AI_GENERATION_LOCK_TTL_MS ?? '120000', 10));
const GENERATION_LOCK_RENEW_MS = Math.max(5_000, Math.min(Math.floor(GENERATION_LOCK_TTL_MS / 3), Number.parseInt(process.env.AI_GENERATION_LOCK_RENEW_MS ?? '30000', 10)));
const GENERATION_LOCK_RENEW_TIMEOUT_MS = Math.max(1_000, Number.parseInt(process.env.AI_GENERATION_LOCK_RENEW_TIMEOUT_MS ?? '5000', 10));
const GENERATION_OPERATION_DEADLINE_MS = Math.max(GENERATION_LOCK_TTL_MS, Number.parseInt(process.env.AI_GENERATION_OPERATION_DEADLINE_MS ?? '240000', 10));
const requireRedis = process.env.REQUIRE_RATE_LIMIT_REDIS === 'true' || process.env.NODE_ENV === 'production';
const redisUrl = getRedisUrl();
let redis: MentoRedisClient | null = null;
const localLocks = new Map<string, { ownerId: string; expiresAt: number }>();

if (redisUrl) {
  redis = createRedisClient(redisUrl);
  redis.on('error', (error) => logger.warn('AI generation lock Redis error', { message: error.message }));
}

function lockKey(conversationId: string): string {
  return `ai:generation:{${conversationId}}`;
}

export class AIGenerationLeaseLostError extends Error {
  readonly code: string = 'generation_lease_lost';
  readonly retryable = true;

  constructor(message = 'Generation coordination was lost. Please retry.') {
    super(message);
    this.name = 'AIGenerationLeaseLostError';
  }
}

export class AIGenerationDeadlineError extends AIGenerationLeaseLostError {
  readonly code = 'generation_deadline_exceeded';

  constructor() {
    super('Generation took too long. Please retry.');
    this.name = 'AIGenerationDeadlineError';
  }
}

export type AIGenerationLease = {
  signal: AbortSignal;
  assertOwned: () => Promise<void>;
  stop: () => void;
  isLost: () => boolean;
};

export async function acquireAIGenerationLock(conversationId: string, ownerId: string): Promise<boolean> {
  if (redis) {
    return await redis.set(lockKey(conversationId), ownerId, 'PX', GENERATION_LOCK_TTL_MS, 'NX') === 'OK';
  }
  if (requireRedis) throw new Error('Redis is required for AI generation coordination.');
  const key = lockKey(conversationId);
  const current = localLocks.get(key);
  if (current && current.expiresAt > Date.now()) return false;
  localLocks.set(key, { ownerId, expiresAt: Date.now() + GENERATION_LOCK_TTL_MS });
  return true;
}

export async function releaseAIGenerationLock(conversationId: string, ownerId: string): Promise<void> {
  if (redis) {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey(conversationId), ownerId);
    return;
  }
  const key = lockKey(conversationId);
  if (localLocks.get(key)?.ownerId === ownerId) localLocks.delete(key);
}

export async function renewAIGenerationLock(conversationId: string, ownerId: string): Promise<boolean> {
  if (redis) {
    const renewed = await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", 1, lockKey(conversationId), ownerId, GENERATION_LOCK_TTL_MS);
    return Number(renewed) === 1;
  }
  const current = localLocks.get(lockKey(conversationId));
  if (current?.ownerId !== ownerId || current.expiresAt <= Date.now()) return false;
  current.expiresAt = Date.now() + GENERATION_LOCK_TTL_MS;
  return true;
}

export async function verifyAIGenerationLockOwner(conversationId: string, ownerId: string): Promise<boolean> {
  if (redis) {
    const owned = await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return 1 else return 0 end", 1, lockKey(conversationId), ownerId);
    return Number(owned) === 1;
  }
  const current = localLocks.get(lockKey(conversationId));
  return current?.ownerId === ownerId && current.expiresAt > Date.now();
}

async function withRenewalTimeout(operation: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<boolean>((_, reject) => {
        timer = setTimeout(() => reject(new AIGenerationLeaseLostError('Generation lease renewal timed out.')), GENERATION_LOCK_RENEW_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startAIGenerationLockHeartbeat(conversationId: string, ownerId: string): AIGenerationLease {
  let stopped = false;
  let lost = false;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const startedAt = Date.now();

  const lose = (error: AIGenerationLeaseLostError) => {
    if (stopped || lost) return;
    lost = true;
    if (renewalTimer) clearTimeout(renewalTimer);
    logger.error('AI generation lock lease lost', { conversationId, reason: error.code });
    controller.abort(error);
  };

  const schedule = () => {
    if (stopped || lost) return;
    const remaining = GENERATION_OPERATION_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining <= 0) return lose(new AIGenerationDeadlineError());
    renewalTimer = setTimeout(async () => {
      try {
        if (Date.now() - startedAt >= GENERATION_OPERATION_DEADLINE_MS) return lose(new AIGenerationDeadlineError());
        const renewed = await withRenewalTimeout(renewAIGenerationLock(conversationId, ownerId));
        if (!renewed) return lose(new AIGenerationLeaseLostError());
      } catch (error) {
        return lose(error instanceof AIGenerationLeaseLostError ? error : new AIGenerationLeaseLostError());
      }
      schedule();
    }, Math.min(GENERATION_LOCK_RENEW_MS, remaining));
    renewalTimer.unref?.();
  };

  schedule();
  return {
    signal: controller.signal,
    isLost: () => lost,
    assertOwned: async () => {
      if (lost || controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new AIGenerationLeaseLostError();
      if (Date.now() - startedAt >= GENERATION_OPERATION_DEADLINE_MS) {
        const error = new AIGenerationDeadlineError();
        lose(error);
        throw error;
      }
      try {
        if (!await withRenewalTimeout(verifyAIGenerationLockOwner(conversationId, ownerId))) {
          const error = new AIGenerationLeaseLostError();
          lose(error);
          throw error;
        }
      } catch (error) {
        const leaseError = error instanceof AIGenerationLeaseLostError ? error : new AIGenerationLeaseLostError();
        lose(leaseError);
        throw leaseError;
      }
    },
    stop: () => {
      stopped = true;
      if (renewalTimer) clearTimeout(renewalTimer);
    },
  };
}

export function getAIGenerationLockStatus() {
  return { configured: Boolean(redisUrl), required: requireRedis, ttlMs: GENERATION_LOCK_TTL_MS, renewMs: GENERATION_LOCK_RENEW_MS, renewTimeoutMs: GENERATION_LOCK_RENEW_TIMEOUT_MS, operationDeadlineMs: GENERATION_OPERATION_DEADLINE_MS };
}
