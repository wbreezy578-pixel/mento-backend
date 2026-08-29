import { getRedisUrl } from './env';
import logger from './logger';
import { createRedisClient, type MentoRedisClient } from './redisClient';

const GENERATION_LOCK_TTL_MS = Math.max(30_000, Number.parseInt(process.env.AI_GENERATION_LOCK_TTL_MS ?? '120000', 10));
const requireRedis = process.env.REQUIRE_RATE_LIMIT_REDIS === 'true' || process.env.NODE_ENV === 'production';
const redisUrl = getRedisUrl();
let redis: MentoRedisClient | null = null;
const localLocks = new Map<string, { ownerId: string; expiresAt: number }>();

if (redisUrl) {
  redis = createRedisClient(redisUrl);
  redis.on('error', (error) => {
    logger.warn('AI generation lock Redis error', { message: error.message });
  });
}

function lockKey(conversationId: string): string {
  return `ai:generation:{${conversationId}}`;
}

export async function acquireAIGenerationLock(conversationId: string, ownerId: string): Promise<boolean> {
  if (redis) {
    const result = await redis.set(lockKey(conversationId), ownerId, 'PX', GENERATION_LOCK_TTL_MS, 'NX');
    return result === 'OK';
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
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey(conversationId),
      ownerId,
    );
    return;
  }
  const key = lockKey(conversationId);
  if (localLocks.get(key)?.ownerId === ownerId) localLocks.delete(key);
}

export function getAIGenerationLockStatus() {
  return { configured: Boolean(redisUrl), required: requireRedis, ttlMs: GENERATION_LOCK_TTL_MS };
}
