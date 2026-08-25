import { getRedisUrl } from './env';
import logger from './logger';
import { createRedisClient, type MentoRedisClient } from './redisClient';

const REALTIME_LEASE_TTL_SECONDS = 30;
const redisUrl = getRedisUrl();
const requireRedis = process.env.REQUIRE_REALTIME_REDIS === 'true';

let redis: MentoRedisClient | null = null;

if (redisUrl) {
  redis = createRedisClient(redisUrl);
  redis.on('error', (error) => {
    logger.warn('[RealtimeRedis] Redis connection error', {
      message: error.message,
      category: 'live_tutor_realtime_redis',
    });
  });
}

function leaseKey(streamId: string): string {
  return `voice_owner:${streamId}`;
}

function sessionKey(streamId: string): string {
  return `voice_session:${streamId}`;
}

function assertRedisAvailable(): MentoRedisClient | null {
  if (!redis && requireRedis) {
    throw new Error('Realtime Redis is required but REDIS_URL is not configured.');
  }
  return redis;
}

export async function acquireVoiceLease(
  streamId: string,
  ownerId: string,
  fields: Record<string, string>,
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;

  const acquired = await client.eval(
    "local current = redis.call('get', KEYS[1]); if not current then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1 elseif current == ARGV[1] then redis.call('expire', KEYS[1], ARGV[2]); return 1 else return 0 end",
    1,
    leaseKey(streamId),
    ownerId,
    String(REALTIME_LEASE_TTL_SECONDS),
  );
  if (Number(acquired) !== 1) return false;

  await client.hset(sessionKey(streamId), {
    ...fields,
    ownerId,
    acquiredAt: new Date().toISOString(),
  });
  await client.expire(sessionKey(streamId), REALTIME_LEASE_TTL_SECONDS);
  return true;
}

export async function refreshVoiceLease(
  streamId: string,
  ownerId: string,
  fields: Record<string, string> = {},
): Promise<boolean> {
  const client = assertRedisAvailable();
  if (!client) return true;

  const leaseResult = await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end",
    1,
    leaseKey(streamId),
    ownerId,
    String(REALTIME_LEASE_TTL_SECONDS),
  );
  if (Number(leaseResult) !== 1) return false;

  if (Object.keys(fields).length > 0) {
    await client.hset(sessionKey(streamId), fields);
  }
  await client.expire(sessionKey(streamId), REALTIME_LEASE_TTL_SECONDS);
  return true;
}

export async function releaseVoiceLease(streamId: string, ownerId: string): Promise<void> {
  const client = assertRedisAvailable();
  if (!client) return;

  await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); redis.call('del', KEYS[2]); return 1 else return 0 end",
    2,
    leaseKey(streamId),
    sessionKey(streamId),
    ownerId,
  );
}

export function getRealtimeRedisStatus(): { configured: boolean; required: boolean } {
  return { configured: Boolean(redisUrl), required: requireRedis };
}

export async function checkRealtimeRedisHealth(): Promise<'ok' | 'not_configured' | 'fail'> {
  try {
    const client = assertRedisAvailable();
    if (!client) return 'not_configured';
    return (await client.ping()) === 'PONG' ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

export async function shutdownRealtimeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
